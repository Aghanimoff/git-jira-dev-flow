// content.js — Git&Jira deroutine Dev Flow

(function () {
  "use strict";

  var CONTAINER_ID = "jira-status-mover-container";
  var MR_PATH_RE = /\/merge_requests\/\d+/;
  var EXT_NAME = "Git&Jira deroutine Dev Flow";

  var _worklogEnabled = false;
  var _autoOpenJira = false;
  var _jiraBaseUrl = "";

  chrome.storage.local.get(["worklogEnabled", "autoOpenJira", "jiraBaseUrl"], function (data) {
    _worklogEnabled = !!data.worklogEnabled;
    _autoOpenJira = !!data.autoOpenJira;
    _jiraBaseUrl = (data.jiraBaseUrl || "").replace(/\/+$/, "");
  });

  (function injectStyles() {
    if (document.getElementById("jira-mover-styles")) return;
    var style = document.createElement("style");
    style.id = "jira-mover-styles";
    style.textContent = [
      ".jira-btn-transition {",
      "  transition: transform 0.15s ease, box-shadow 0.15s ease, opacity 0.3s ease;",
      "}",
      ".jira-btn-transition:hover:not(:disabled) {",
      "  transform: translateY(-1px);",
      "  box-shadow: 0 2px 8px rgba(0,0,0,0.25);",
      "}",
      ".jira-btn-transition:active:not(:disabled) {",
      "  transform: scale(0.95);",
      "}"
    ].join("\n");
    document.head.appendChild(style);
  })();

  // { label, transitionName (null = no transition), color, worklogComment, visibility }
  var BUTTONS = [
    { label: "CodeReview",    transitionName: null,            color: "rgb(85, 85, 85)",   worklogComment: "Code Review",          visibility: { status: "open",   branches: ["develop"] } },
    { label: "Bugfix",        transitionName: "bugfix",        color: "rgb(83, 46, 22)",   worklogComment: "Code Review (bugfix)", visibility: { status: "open",   branches: ["develop"] } },
    { label: "Internal Test", transitionName: "internal test", color: "rgb(99, 166, 233)", worklogComment: "Release to Dev",       visibility: { status: "merged", branches: ["develop"] } },
    { label: "Test Control",  transitionName: "test control",  color: "rgb(99, 166, 233)", worklogComment: "Release to Test",      visibility: { status: "merged", branches: ["stage"] } },
    { label: "Done",          transitionName: "done",          color: "rgb(99, 166, 233)", worklogComment: "Release to Master",    visibility: { status: "merged", branches: ["master"] } }
  ];

  // --- MR state detection ---

  function detectMRStatus() {
    if (document.querySelector(".status-box-mr-merged, .status-box.status-box-merged")) return "merged";
    if (document.querySelector(".status-box-open, .status-box.status-box-open")) return "open";
    if (document.querySelector(".status-box-closed, .status-box.status-box-closed")) return "closed";

    var badges = document.querySelectorAll(".badge");
    for (var i = 0; i < badges.length; i++) {
      var t = (badges[i].textContent || "").trim().toLowerCase();
      if (t === "merged" || t === "open" || t === "closed") return t;
    }

    return null;
  }

  function detectTargetBranch() {
    var el = document.querySelector(".js-target-branch");
    if (el) return (el.textContent || "").trim().toLowerCase();

    var refs = document.querySelectorAll(".ref-name");
    if (refs.length >= 2) return (refs[1].textContent || "").trim().toLowerCase();

    var testEl = document.querySelector("[data-testid='target-branch-link']");
    if (testEl) return (testEl.textContent || "").trim().toLowerCase();

    // Last /-/tree/ link (excluding "Repository" nav) is typically target branch
    var branchLinks = document.querySelectorAll("a[href*='/-/tree/']");
    for (var b = branchLinks.length - 1; b >= 0; b--) {
      var text = (branchLinks[b].textContent || "").trim();
      if (text && text.toLowerCase() !== "repository") return text.toLowerCase();
    }

    return null;
  }

  // --- Button visibility ---

  var _visibilityTimer = null;
  var _visibilityRetries = 0;
  var MAX_VISIBILITY_RETRIES = 20;
  var _visibilityResolved = false;

  function updateButtonVisibility() {
    if (_visibilityResolved) return;

    var container = document.getElementById(CONTAINER_ID);
    if (!container) return;

    var status = detectMRStatus();
    var targetBranch = detectTargetBranch();

    if (!status || !targetBranch) {
      if (_visibilityRetries < MAX_VISIBILITY_RETRIES) {
        _visibilityRetries++;
        clearTimeout(_visibilityTimer);
        _visibilityTimer = setTimeout(updateButtonVisibility, 500);
      } else {
        // Fallback: show all buttons after timeout
        _visibilityResolved = true;
        applyVisibility(container, null, null);
      }
      return;
    }

    _visibilityResolved = true;
    _visibilityRetries = 0;
    clearTimeout(_visibilityTimer);
    applyVisibility(container, status, targetBranch);
  }

  function applyVisibility(container, status, targetBranch) {
    var btns = container.querySelectorAll("button[data-btn-label]");
    var anyVisible = false;

    for (var i = 0; i < btns.length; i++) {
      var label = btns[i].dataset.btnLabel;
      var def = null;
      for (var j = 0; j < BUTTONS.length; j++) {
        if (BUTTONS[j].label === label) { def = BUTTONS[j]; break; }
      }
      if (!def) continue;

      var show = (!status || !targetBranch)
        ? true
        : def.visibility.status === status && def.visibility.branches.indexOf(targetBranch) !== -1;

      // CodeReview is only useful with worklog enabled
      if (!def.transitionName && !_worklogEnabled) show = false;

      btns[i].style.display = show ? "" : "none";
      if (show) anyVisible = true;
    }

    container.style.display = anyVisible ? "inline-flex" : "none";
  }

  function resetVisibilityState() {
    _visibilityRetries = 0;
    _visibilityResolved = false;
    clearTimeout(_visibilityTimer);
  }

  // --- Time distribution ---

  // Distribute totalMinutes across count issues, each rounded up to nearest 5 (min 5).
  function distributeMinutes(totalMinutes, count) {
    if (count <= 0) return [];
    var allocations = [];
    var remaining = totalMinutes;

    for (var i = 0; i < count; i++) {
      var share = remaining / (count - i);
      var rounded = Math.ceil(share / 5) * 5;
      if (rounded < 5) rounded = 5;
      allocations.push(rounded);
      remaining -= rounded;
    }

    return allocations;
  }

  // --- Jira key extraction ---

  var JIRA_URL_RE = /https?:\/\/[^\s\/]+\/browse\/([A-Z][A-Z0-9_]+-\d+)/gi;
  var JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/g;

  function extractJiraKeys(text) {
    var keys = {};
    var m;

    JIRA_URL_RE.lastIndex = 0;
    while ((m = JIRA_URL_RE.exec(text)) !== null) keys[m[1].toUpperCase()] = true;

    JIRA_KEY_RE.lastIndex = 0;
    while ((m = JIRA_KEY_RE.exec(text)) !== null) keys[m[1].toUpperCase()] = true;

    return Object.keys(keys);
  }

  // --- MR title / description ---

  function getMRDescriptionText() {
    var el = document.querySelector(".detail-page-description .md") ||
             document.querySelector(".description .md") ||
             document.querySelector(".merge-request-details .md");
    return el ? (el.innerText || "") : "";
  }

  function getMRTitleText() {
    var el = document.querySelector(".detail-page-header .title") ||
             document.querySelector(".merge-request-details .title") ||
             document.querySelector("[data-testid='title-content']") ||
             document.querySelector(".page-title");
    return el ? (el.innerText || "") : "";
  }

  // --- UI creation ---

  function createButtonContainer() {
    var container = document.createElement("span");
    container.id = CONTAINER_ID;
    container.style.display = "none";
    container.style.gap = "6px";
    container.style.marginLeft = "auto";
    container.style.flexWrap = "wrap";
    container.style.alignItems = "center";

    var jiraLabel = document.createElement("span");
    jiraLabel.textContent = "Jira:";
    jiraLabel.style.fontWeight = "600";
    jiraLabel.style.fontSize = "13px";
    jiraLabel.style.color = "currentColor";
    container.appendChild(jiraLabel);

    if (_worklogEnabled) {
      container.appendChild(createMinutesInput());
      var minLabel = document.createElement("span");
      minLabel.textContent = "min to worklog";
      minLabel.style.fontSize = "12px";
      minLabel.style.color = "currentColor";
      minLabel.style.opacity = "0.7";
      minLabel.title = "Time will be logged to each linked Jira issue.\nIf multiple issues found, minutes are distributed evenly (rounded up to 5 min each).";
      minLabel.style.cursor = "help";
      container.appendChild(minLabel);
    }

    BUTTONS.forEach(function (def) {
      container.appendChild(createSingleButton(def));
    });

    return container;
  }

  function createMinutesInput() {
    var input = document.createElement("input");
    input.id = "jira-worklog-minutes";
    input.type = "number";
    input.min = "0";
    input.step = "5";
    input.value = "5";
    input.title = "Time will be logged to each linked Jira issue.\nIf multiple issues found, minutes are distributed evenly (rounded up to 5 min each).";
    input.style.cssText = [
      "width: 48px",
      "height: 24px",
      "padding: 2px 4px",
      "font-size: 12px",
      "text-align: center",
      "border: 1px solid currentColor",
      "border-radius: 4px",
      "color: inherit",
      "background: var(--gl-background-color-subtle, var(--input-bg, transparent))",
      "opacity: 0.85"
    ].join(";");
    return input;
  }

  function createSingleButton(def) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn gl-button btn-sm jira-btn-transition";
    btn.style.backgroundColor = def.color;
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.cursor = "pointer";
    btn.dataset.transitionName = def.transitionName;
    btn.dataset.btnLabel = def.label;
    btn.style.display = "none";

    var tooltipLines = [];
    if (def.transitionName) {
      tooltipLines.push("Move linked Jira issues to \"" + def.label + "\" status");
    } else {
      tooltipLines.push("Log time without changing Jira issue status");
    }
    if (_worklogEnabled) {
      tooltipLines.push("Log worklog: \"" + def.worklogComment + "\"");
    }
    btn.title = tooltipLines.join("\n");

    var textSpan = document.createElement("span");
    textSpan.className = "gl-button-text";
    textSpan.textContent = def.label;
    btn.appendChild(textSpan);

    btn.addEventListener("click", handleButtonClick.bind(null, btn, def));
    return btn;
  }

  function setAllButtonsDisabled(disabled) {
    var container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    var btns = container.querySelectorAll("button[data-btn-label]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = disabled;
      btns[i].style.opacity = disabled ? "0.6" : "1";
      btns[i].style.cursor = disabled ? "default" : "pointer";
    }
  }

  function handleButtonClick(btn, def) {
    setAllButtonsDisabled(true);

    var text = getMRTitleText() + "\n" + getMRDescriptionText();
    var issueKeys = extractJiraKeys(text);

    if (issueKeys.length === 0) {
      showToast("No Jira issue keys found in MR description / title.", true);
      setAllButtonsDisabled(false);
      return;
    }

    var worklogs = [];
    if (_worklogEnabled) {
      var minutesInput = document.getElementById("jira-worklog-minutes");
      var totalMinutes = parseInt(minutesInput ? minutesInput.value : "5", 10) || 0;
      var allocations = distributeMinutes(totalMinutes, issueKeys.length);
      worklogs = issueKeys.map(function (key, idx) {
        return { issueKey: key, minutes: allocations[idx], comment: def.worklogComment };
      });
    }

    chrome.runtime.sendMessage(
      {
        action: "processJiraAction",
        issueKeys: issueKeys,
        transitionName: def.transitionName,
        worklogs: worklogs
      },
      function (response) {
        if (chrome.runtime.lastError) {
          showToast("Extension error: " + chrome.runtime.lastError.message, true);
          setAllButtonsDisabled(false);
          return;
        }
        if (!response) {
          showToast("No response from background.", true);
          setAllButtonsDisabled(false);
          return;
        }

        var parts = [];
        if (response.success > 0) parts.push("\u2713 " + def.label + " \u2014 Success: " + response.success);
        if (response.failed > 0)  parts.push("Failed: " + response.failed);
        if (response.errors && response.errors.length) parts.push("\n" + response.errors.join("\n"));
        showToast(parts.join(" | "), response.failed > 0);

        if (_autoOpenJira && _jiraBaseUrl) {
          chrome.runtime.sendMessage({
            action: "openJiraTabs",
            urls: issueKeys.map(function (key) { return _jiraBaseUrl + "/browse/" + key; })
          });
        }
      }
    );
  }

  // --- Toast ---

  function showToast(msg, isError) {
    var toast = document.createElement("div");
    toast.textContent = msg;
    toast.style.cssText = [
      "position: fixed",
      "bottom: 24px",
      "right: 24px",
      "max-width: 480px",
      "padding: 12px 20px",
      "border-radius: 6px",
      "font-size: 13px",
      "line-height: 1.4",
      "color: #fff",
      "background:" + (isError ? " #d9534f" : " #2da160"),
      "box-shadow: 0 4px 12px rgba(0,0,0,0.25)",
      "z-index: 999999",
      "white-space: pre-wrap",
      "word-break: break-word",
      "transition: opacity 0.3s"
    ].join(";");

    document.body.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = "0";
      setTimeout(function () {
        if (toast.parentNode) toast.parentNode.removeChild(toast);
      }, 400);
    }, 6000);
  }

  // --- Injection (SPA-aware) ---

  function isMRPage() {
    return MR_PATH_RE.test(window.location.pathname);
  }

  function injectButtons() {
    if (!isMRPage()) { removeButtons(); return; }
    if (document.getElementById(CONTAINER_ID)) return;

    var target = findInjectionTarget();
    if (target) {
      target.appendChild(createButtonContainer());
      updateButtonVisibility();
    }
  }

  function findInjectionTarget() {
    var summaryRow = document.querySelector("[data-testid='approvals-summary-content']");
    if (summaryRow) {
      var mb = summaryRow.closest(".media-body");
      if (mb) return mb;
    }

    var approveBtn = document.querySelector("[data-testid='approve-button']");
    if (approveBtn) {
      return approveBtn.closest(".media-body") || approveBtn.parentNode;
    }

    var approvalsSection = document.querySelector(".js-mr-approvals");
    if (approvalsSection) {
      return approvalsSection.querySelector(".state-container-action-buttons") ||
             approvalsSection.querySelector(".mr-widget-body") ||
             null;
    }

    return null;
  }

  function removeButtons() {
    var container = document.getElementById(CONTAINER_ID);
    if (container && container.parentNode) container.parentNode.removeChild(container);
  }

  // --- MutationObserver ---

  var lastUrl = window.location.href;

  var observer = new MutationObserver(function () {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      removeButtons();
      resetVisibilityState();
      setTimeout(injectButtons, 800);
    }
    if (isMRPage() && !document.getElementById(CONTAINER_ID)) {
      injectButtons();
    }
  });

  observer.observe(document.body, { childList: true, subtree: true });
  injectButtons();
})();
