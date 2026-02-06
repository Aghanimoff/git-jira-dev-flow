// options.js — Git&Jira deroutine Dev Flow

(function () {
  "use strict";

  var jiraBaseUrlInput = document.getElementById("jiraBaseUrl");
  var usernameInput = document.getElementById("username");
  var passwordInput = document.getElementById("password");
  var worklogCheckbox = document.getElementById("worklogEnabled");
  var autoOpenCheckbox = document.getElementById("autoOpenJira");
  var saveBtn = document.getElementById("save");
  var statusEl = document.getElementById("status");

  chrome.storage.local.get(["jiraBaseUrl", "username", "password", "worklogEnabled", "autoOpenJira"], function (data) {
    if (data.jiraBaseUrl) jiraBaseUrlInput.value = data.jiraBaseUrl;
    if (data.username) usernameInput.value = data.username;
    if (data.password) passwordInput.value = data.password;
    worklogCheckbox.checked = !!data.worklogEnabled;
    autoOpenCheckbox.checked = !!data.autoOpenJira;
  });

  saveBtn.addEventListener("click", function () {
    var jiraBaseUrl = jiraBaseUrlInput.value.trim();
    var username = usernameInput.value.trim();
    var password = passwordInput.value;

    if (!jiraBaseUrl || !username || !password) {
      statusEl.textContent = "All fields are required.";
      statusEl.style.color = "#d9534f";
      return;
    }

    chrome.storage.local.set({
      jiraBaseUrl: jiraBaseUrl,
      username: username,
      password: password,
      worklogEnabled: worklogCheckbox.checked,
      autoOpenJira: autoOpenCheckbox.checked
    }, function () {
      statusEl.textContent = "Settings saved!";
      statusEl.style.color = "#2da160";
      setTimeout(function () { statusEl.textContent = ""; }, 2500);
    });
  });
})();
