// background.js — Git&Jira deroutine Dev Flow

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action === "openJiraTabs") {
    var tabIndex = (sender.tab && sender.tab.index != null) ? sender.tab.index + 1 : undefined;
    (message.urls || []).forEach(function (url, i) {
      var opts = { url: url, active: (i === 0) };
      if (tabIndex !== undefined) opts.index = tabIndex + i;
      chrome.tabs.create(opts);
    });
    return false;
  }

  if (message.action === "checkIssueStatuses") {
    var issueKeys = message.issueKeys || [];
    var targetStatus = message.targetStatus || "";

    if (issueKeys.length === 0) {
      sendResponse({ allInTargetStatus: false, statuses: [], errors: ["No issue keys provided."] });
      return true;
    }

    chrome.storage.local.get(["jiraBaseUrl", "username", "password"], function (cfg) {
      console.log("[JiraDevFlow][background.js] Credentials used:", cfg);
      var baseUrl = cfg.jiraBaseUrl ? cfg.jiraBaseUrl.replace(/\/+$/, "") : "";
      var authHeader = "Basic " + btoa(cfg.username + ":" + cfg.password);
      console.log("[JiraDevFlow][background.js] Authorization header:", authHeader);
      
      checkIssueStatuses(baseUrl, authHeader, issueKeys, targetStatus, sendResponse);
    });
    return true;
  }

  if (message.action !== "processJiraAction") return false;

  var issueKeys = message.issueKeys || [];
  var transitionName = message.transitionName || null;
  var worklogs = message.worklogs || [];

  if (issueKeys.length === 0) {
    sendResponse({ success: 0, failed: 0, errors: ["No Jira issue keys provided."] });
    return true;
  }

  chrome.storage.local.get(["jiraBaseUrl", "username", "password"], function (cfg) {
    console.log("[JiraDevFlow][background.js] Credentials used:", cfg);
    var baseUrl = cfg.jiraBaseUrl ? cfg.jiraBaseUrl.replace(/\/+$/, "") : "";
    var authHeader = "Basic " + btoa(cfg.username + ":" + cfg.password);
    console.log("[JiraDevFlow][background.js] Authorization header:", authHeader);
    var results = { success: 0, failed: 0, errors: [] };

    // --- Transition ops (parallel) ---
    var transitionOps = [];
    if (transitionName) {
      issueKeys.forEach(function (key) {
        transitionOps.push(function (done) {
          transitionIssue(baseUrl, authHeader, key, transitionName, results, done);
        });
      });
    }

    // --- Worklog entries (sequential, with overlap detection) ---
    var worklogEntries = worklogs.filter(function (wl) { return wl.minutes > 0; });

    if (transitionOps.length === 0 && worklogEntries.length === 0) {
      sendResponse({ success: 0, failed: 0, errors: ["Nothing to do."] });
      return;
    }

    var transitionsDone = transitionOps.length === 0;
    var worklogsDone = worklogEntries.length === 0;

    function checkAllDone() {
      if (transitionsDone && worklogsDone) sendResponse(results);
    }

    // Launch transitions in parallel
    if (transitionOps.length > 0) {
      var pending = transitionOps.length;
      transitionOps.forEach(function (op) {
        op(function () {
          if (--pending <= 0) {
            transitionsDone = true;
            checkAllDone();
          }
        });
      });
    }

    // Process worklogs: fetch existing, then create sequentially in free slots
    if (worklogEntries.length > 0) {
      fetchUserWorklogsForToday(baseUrl, authHeader, function (err, busyIntervals) {
        if (err) busyIntervals = []; // proceed without overlap check on error

        var roundedNow = roundUpTo5Minutes(new Date());
        var idx = 0;

        function nextWorklog() {
          if (idx >= worklogEntries.length) {
            worklogsDone = true;
            checkAllDone();
            return;
          }
          var wl = worklogEntries[idx++];
          var durationMs = wl.minutes * 60 * 1000;
          var startDate = findFreeSlot(busyIntervals, roundedNow.getTime(), durationMs);

          // Register this slot so subsequent worklogs won't overlap with it
          busyIntervals.push({ start: startDate.getTime(), end: startDate.getTime() + durationMs });

          logWorklog(baseUrl, authHeader, wl.issueKey, wl.minutes, wl.comment, startDate, results, nextWorklog);
        }

        nextWorklog();
      });
    }
  });

  return true;
});

function checkIssueStatuses(baseUrl, authHeader, issueKeys, targetStatus, sendResponse) {
  var results = { allInTargetStatus: true, statuses: [], errors: [] };
  var pending = issueKeys.length;
  if (pending === 0) { sendResponse(results); return; }

  issueKeys.forEach(function (key) {
    jiraFetch(baseUrl, authHeader, "/rest/api/2/issue/" + key + "?fields=status")
      .then(function (data) {
        var cur = (data.fields && data.fields.status && data.fields.status.name) || "Unknown";
        var match = cur.toLowerCase() === targetStatus.toLowerCase();
        results.statuses.push({ issueKey: key, currentStatus: cur, isInTargetStatus: match });
        if (!match) results.allInTargetStatus = false;
        if (--pending <= 0) sendResponse(results);
      })
      .catch(function (err) {
        results.errors.push(err.message || String(err));
        results.allInTargetStatus = false;
        if (--pending <= 0) sendResponse(results);
      });
  });
}

function transitionIssue(baseUrl, authHeader, issueKey, transitionName, results, done) {
  var path = "/rest/api/2/issue/" + issueKey + "/transitions";
  var targetLower = transitionName.toLowerCase();

  jiraFetch(baseUrl, authHeader, path)
    .then(function (data) {
      var transitions = data.transitions || [];
      var target = transitions.find(function (t) { return t.name && t.name.toLowerCase() === targetLower; });
      if (!target) {
        throw new Error(issueKey + ': transition "' + transitionName + '" not found. Available: ' +
          transitions.map(function (t) { return t.name; }).join(", "));
      }
      return jiraFetch(baseUrl, authHeader, path, "POST", { transition: { id: target.id } });
    })
    .then(function () { results.success++; done(); })
    .catch(function (err) { results.failed++; results.errors.push(err.message || String(err)); done(); });
}

// --- Helpers ---

function jiraFetch(baseUrl, authHeader, path, method, body) {
  var opts = { method: method || "GET", headers: { "Authorization": authHeader, "Content-Type": "application/json" } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(baseUrl + path, opts).then(function (r) {
    if (!r.ok) throw new Error(path + " failed: HTTP " + r.status);
    var ct = r.headers.get("content-type") || "";
    return ct.indexOf("json") !== -1 ? r.json() : r.text();
  });
}

var FIVE_MIN_MS = 5 * 60 * 1000;

// Round up to nearest 5-min boundary (e.g. 1:02:45 → 1:05:00)
function roundUpTo5Minutes(date) {
  var ms = date.getTime(), rem = ms % FIVE_MIN_MS;
  return new Date(rem === 0 ? ms : ms + FIVE_MIN_MS - rem);
}

function formatJiraDateTime(date) {
  var p = function (n) { return String(n).padStart(2, "0"); };
  var tz = date.getTimezoneOffset(), sign = tz <= 0 ? "+" : "-", abs = Math.abs(tz);
  return date.getFullYear() + "-" + p(date.getMonth() + 1) + "-" + p(date.getDate()) +
    "T" + p(date.getHours()) + ":" + p(date.getMinutes()) + ":" + p(date.getSeconds()) +
    ".000" + sign + p(Math.floor(abs / 60)) + p(abs % 60);
}

// Fetch today's worklog intervals for the current user → callback(err, [{start,end}])
function fetchUserWorklogsForToday(baseUrl, authHeader, callback) {
  var hdr = { "Authorization": authHeader, "Content-Type": "application/json" };
  jiraFetch(baseUrl, authHeader, "/rest/api/2/myself")
    .then(function (user) {
      var uid = user.name || user.key || user.accountId || "";
      var jql = encodeURIComponent("worklogAuthor = currentUser() AND worklogDate >= startOfDay()");
      return jiraFetch(baseUrl, authHeader, "/rest/api/2/search?jql=" + jql + "&fields=key&maxResults=100")
        .then(function (data) { return { uid: uid, keys: (data.issues || []).map(function (i) { return i.key; }) }; });
    })
    .then(function (r) {
      if (r.keys.length === 0) return callback(null, []);
      var intervals = [], pending = r.keys.length;
      r.keys.forEach(function (key) {
        jiraFetch(baseUrl, authHeader, "/rest/api/2/issue/" + key + "/worklog")
          .then(function (data) {
            (data.worklogs || []).forEach(function (wl) {
              var a = wl.author;
              if (a && (a.name === r.uid || a.key === r.uid || a.accountId === r.uid)) {
                var s = new Date(wl.started).getTime();
                intervals.push({ start: s, end: s + (wl.timeSpentSeconds || 0) * 1000 });
              }
            });
            if (--pending <= 0) callback(null, intervals);
          })
          .catch(function () { if (--pending <= 0) callback(null, intervals); });
      });
    })
    .catch(function (err) { callback(err, []); });
}

// Find earliest 5-min-aligned free slot starting at or after proposedStartMs
function findFreeSlot(busyIntervals, proposedStartMs, durationMs) {
  var s = proposedStartMs;
  busyIntervals.sort(function (a, b) { return a.start - b.start; });
  for (var attempt = 0; attempt < 288; attempt++) {
    var e = s + durationMs, hit = false;
    for (var i = 0; i < busyIntervals.length; i++) {
      if (s < busyIntervals[i].end && e > busyIntervals[i].start) {
        var nxt = busyIntervals[i].end, rem = nxt % FIVE_MIN_MS;
        s = rem === 0 ? nxt : nxt + FIVE_MIN_MS - rem;
        hit = true; break;
      }
    }
    if (!hit) return new Date(s);
  }
  return new Date(proposedStartMs);
}

function logWorklog(baseUrl, authHeader, issueKey, minutes, comment, startDate, results, done) {
  jiraFetch(baseUrl, authHeader, "/rest/api/2/issue/" + issueKey + "/worklog", "POST",
    { timeSpentSeconds: minutes * 60, started: formatJiraDateTime(startDate), comment: comment })
    .then(function () { results.success++; done(); })
    .catch(function (err) { results.failed++; results.errors.push(err.message || String(err)); done(); });
}
