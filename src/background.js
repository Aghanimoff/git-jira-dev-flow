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
      if (!cfg.jiraBaseUrl || !cfg.username || !cfg.password) {
        sendResponse({ allInTargetStatus: false, statuses: [], errors: ["Jira credentials not configured."] });
        return;
      }

      var baseUrl = cfg.jiraBaseUrl.replace(/\/+$/, "");
      var authHeader = "Basic " + btoa(cfg.username + ":" + cfg.password);
      
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
    if (!cfg.jiraBaseUrl || !cfg.username || !cfg.password) {
      sendResponse({ success: 0, failed: issueKeys.length, errors: ["Jira credentials not configured. Open extension options."] });
      return;
    }

    var baseUrl = cfg.jiraBaseUrl.replace(/\/+$/, "");
    var authHeader = "Basic " + btoa(cfg.username + ":" + cfg.password);
    var results = { success: 0, failed: 0, errors: [] };
    var ops = [];

    if (transitionName) {
      issueKeys.forEach(function (key) {
        ops.push(function (done) {
          transitionIssue(baseUrl, authHeader, key, transitionName, results, done);
        });
      });
    }

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
    ops.forEach(function (op) {
      op(function () {
        if (--pending <= 0) sendResponse(results);
      });
    });
  });

  return true;
});

function checkIssueStatuses(baseUrl, authHeader, issueKeys, targetStatus, sendResponse) {
  var results = { allInTargetStatus: true, statuses: [], errors: [] };
  var pending = issueKeys.length;
  
  if (pending === 0) {
    sendResponse(results);
    return;
  }

  issueKeys.forEach(function (issueKey) {
    var url = baseUrl + "/rest/api/2/issue/" + issueKey + "?fields=status";
    
    fetch(url, {
      method: "GET",
      headers: { "Authorization": authHeader, "Content-Type": "application/json" }
    })
      .then(function (resp) {
        if (!resp.ok) throw new Error("GET status for " + issueKey + " failed: HTTP " + resp.status);
        return resp.json();
      })
      .then(function (data) {
        var currentStatus = (data.fields && data.fields.status && data.fields.status.name) || "Unknown";
        var isInTargetStatus = currentStatus.toLowerCase() === targetStatus.toLowerCase();
        
        results.statuses.push({
          issueKey: issueKey,
          currentStatus: currentStatus,
          isInTargetStatus: isInTargetStatus
        });
        
        if (!isInTargetStatus) {
          results.allInTargetStatus = false;
        }
        
        if (--pending <= 0) {
          sendResponse(results);
        }
      })
      .catch(function (err) {
        results.errors.push(err.message || String(err));
        results.allInTargetStatus = false;
        
        if (--pending <= 0) {
          sendResponse(results);
        }
      });
  });
}

function transitionIssue(baseUrl, authHeader, issueKey, transitionName, results, done) {
  var url = baseUrl + "/rest/api/2/issue/" + issueKey + "/transitions";
  var targetLower = transitionName.toLowerCase();

  fetch(url, {
    method: "GET",
    headers: { "Authorization": authHeader, "Content-Type": "application/json" }
  })
    .then(function (resp) {
      if (!resp.ok) throw new Error("GET transitions for " + issueKey + " failed: HTTP " + resp.status);
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
        var available = transitions.map(function (t) { return t.name; }).join(", ");
        throw new Error(issueKey + ': transition "' + transitionName + '" not found. Available: ' + available);
      }
      return fetch(url, {
        method: "POST",
        headers: { "Authorization": authHeader, "Content-Type": "application/json" },
        body: JSON.stringify({ transition: { id: target.id } })
      });
    })
    .then(function (resp) {
      if (!resp.ok) throw new Error(issueKey + ": POST transition failed: HTTP " + resp.status);
      results.success++;
      done();
    })
    .catch(function (err) {
      results.failed++;
      results.errors.push(err.message || String(err));
      done();
    });
}

function logWorklog(baseUrl, authHeader, issueKey, minutes, comment, results, done) {
  var url = baseUrl + "/rest/api/2/issue/" + issueKey + "/worklog";
  var now = new Date();
  var pad = function (n) { return String(n).padStart(2, "0"); };

  var tz = now.getTimezoneOffset();
  var tzSign = tz <= 0 ? "+" : "-";
  var tzAbs = Math.abs(tz);
  var started = now.getFullYear() + "-" + pad(now.getMonth() + 1) + "-" + pad(now.getDate()) +
    "T" + pad(now.getHours()) + ":" + pad(now.getMinutes()) + ":" + pad(now.getSeconds()) +
    ".000" + tzSign + pad(Math.floor(tzAbs / 60)) + pad(tzAbs % 60);

  fetch(url, {
    method: "POST",
    headers: { "Authorization": authHeader, "Content-Type": "application/json" },
    body: JSON.stringify({
      timeSpentSeconds: minutes * 60,
      started: started,
      comment: comment
    })
  })
    .then(function (resp) {
      if (!resp.ok) throw new Error(issueKey + ": worklog POST failed: HTTP " + resp.status);
      results.success++;
      done();
    })
    .catch(function (err) {
      results.failed++;
      results.errors.push(err.message || String(err));
      done();
    });
}
