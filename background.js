// background.js — Service Worker for Jira transition calls

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message.action !== "moveToJiraBugfix") {
    return false;
  }

  var issueKeys = message.issueKeys || [];
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
    var pending = issueKeys.length;

    function checkDone() {
      pending--;
      if (pending <= 0) {
        sendResponse(results);
      }
    }

    issueKeys.forEach(function (key) {
      transitionIssue(baseUrl, authHeader, key, results, checkDone);
    });
  });

  // return true to keep sendResponse channel open for async work
  return true;
});


function transitionIssue(baseUrl, authHeader, issueKey, results, done) {
  var transitionsUrl = baseUrl + "/rest/api/2/issue/" + issueKey + "/transitions";

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
        if (transitions[i].name && transitions[i].name.toLowerCase() === "bugfix") {
          target = transitions[i];
          break;
        }
      }

      if (!target) {
        throw new Error(issueKey + ": transition \"bugfix\" not found. Available: " +
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
