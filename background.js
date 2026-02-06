// background.js — Service Worker for Jira transition + worklog calls

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action !== "processJiraAction") {
    return false;
  }

  var issueKeys = message.issueKeys || [];
  var transitionName = message.transitionName || null; // null = no transition (e.g. CodeReview)
  var worklogs = message.worklogs || [];

  if (issueKeys.length === 0) {
    sendResponse({ success: 0, failed: 0, errors: ["No Jira issue keys provided."] });
    return true;
  }

  chrome.storage.local.get(["jiraBaseUrl", "username", "password"], function (cfg) {
    if (!cfg.jiraBaseUrl || !cfg.username || !cfg.password) {
      sendResponse({ success: 0, failed: issueKeys.length, errors: ["Jira credentials not configured. Open extension options."] });
      return;
    }

    var baseUrl = cfg.jiraBaseUrl.replace(/\/+$/, "");
    var authHeader = "Basic " + btoa(cfg.username + ":" + cfg.password);

    var results = { success: 0, failed: 0, errors: [] };

    // Build a list of all operations to perform
    var ops = [];

    // 1. Transitions (if transitionName is set)
    if (transitionName) {
      issueKeys.forEach(function (key) {
        ops.push(function (done) {
          transitionIssue(baseUrl, authHeader, key, transitionName, results, done);
        });
      });
    }

    // 2. Worklogs
    worklogs.forEach(function (wl) {
      if (wl.minutes > 0) {
        ops.push(function (done) {
          logWorklog(baseUrl, authHeader, wl.issueKey, wl.minutes, wl.comment, results, done);
        });
      }
    });

    if (ops.length === 0) {
      sendResponse({ success: 0, failed: 0, errors: ["Nothing to do."] });
      return;
    }

    var pending = ops.length;
    function checkDone() {
      pending--;
      if (pending <= 0) {
        sendResponse(results);
      }
    }

    ops.forEach(function (op) {
      op(checkDone);
    });
  });

  // return true to keep sendResponse channel open for async work
  return true;
});


// ---- Transition an issue to a target status ----

function transitionIssue(baseUrl, authHeader, issueKey, transitionName, results, done) {
  var transitionsUrl = baseUrl + "/rest/api/2/issue/" + issueKey + "/transitions";
  var targetLower = transitionName.toLowerCase();

  fetch(transitionsUrl, {
    method: "GET",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json"
    }
  })
    .then(function (resp) {
      if (!resp.ok) {
        throw new Error("GET transitions for " + issueKey + " failed: HTTP " + resp.status);
      }
      return resp.json();
    })
    .then(function (data) {
      var transitions = data.transitions || [];
      var target = null;

      for (var i = 0; i < transitions.length; i++) {
        if (transitions[i].name && transitions[i].name.toLowerCase() === targetLower) {
          target = transitions[i];
          break;
        }
      }

      if (!target) {
        throw new Error(issueKey + ": transition \"" + transitionName + "\" not found. Available: " +
          transitions.map(function (t) { return t.name; }).join(", "));
      }

      return fetch(transitionsUrl, {
        method: "POST",
        headers: {
          "Authorization": authHeader,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          "transition": {
            "id": target.id
          }
        })
      });
    })
    .then(function (resp) {
      if (!resp.ok) {
        throw new Error(issueKey + ": POST transition failed: HTTP " + resp.status);
      }
      results.success++;
      done();
    })
    .catch(function (err) {
      results.failed++;
      results.errors.push(err.message || String(err));
      done();
    });
}


// ---- Log worklog to a Jira issue ----

function logWorklog(baseUrl, authHeader, issueKey, minutes, comment, results, done) {
  var worklogUrl = baseUrl + "/rest/api/2/issue/" + issueKey + "/worklog";

  // Build started timestamp in Jira format: "2026-02-06T10:00:00.000+0000"
  var now = new Date();
  var pad = function (n, len) { var s = String(n); while (s.length < (len || 2)) s = "0" + s; return s; };
  var tz = now.getTimezoneOffset();
  var tzSign = tz <= 0 ? "+" : "-";
  var tzAbs = Math.bs(tz);
  var tzHours = pad(Math.floor(tzAbs / 60));
  var tzMins = pad(tzAbs % 60);
  var started = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) +
    "T" + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()) +
    ".000" + tzSign + tzHours + tzMins;

  var payload = {
    "timeSpentSeconds": minutes * 60,
    "started": started,
    "comment": comment
  };

  fetch(worklogUrl, {
    method: "POST",
    headers: {
      "Authorization": authHeader,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  })
    .then(function (resp) {
      if (!resp.ok) {
        throw new Error(issueKey + ": worklog POST failed: HTTP " + resp.status);
      }
      results.success++;
      done();
    })
    .catch(function (err) {
      results.failed++;
      results.errors.push(err.message || String(err));
      done();
    });
}
