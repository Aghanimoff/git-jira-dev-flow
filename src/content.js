// content.js — Git&Jira deroutine Dev Flow

(function () {
  "use strict";

  var CONTAINER_ID = "jira-status-mover-container";
  var CONTAINER_SELECTOR = "#" + CONTAINER_ID;
  var MR_PATH_RE = /\/merge_requests\/\d+/;
  var STORAGE_KEYS = ["worklogEnabled", "autoOpenJira", "jiraBaseUrl", "buttons"];
  var STATUS_CHECK_RETRY_MS = 500;
  var STATUS_CHECK_RETRIES_MAX = 20;
  var VISIBILITY_REFRESH_DEBOUNCE_MS = 120;
  var WARNING_INDICATORS_DELAY_MS = 100;
  var AUTO_TRIGGER_COOLDOWN_MS = 1200;
  var AUTO_TRIGGER_STEP_DELAY_MS = 250;
  var MERGE_PENDING_TTL_MS = 120000;
  var CLICK_ACTION_DELAY_MS = 250;
  var SPA_NAVIGATION_INJECT_DELAY_MS = 800;
  var WORKLOG_TOOLTIP = "Time will be logged to each linked Jira issue.\nIf multiple issues found, minutes are distributed evenly (rounded up to 5 min each).";
  var MR_STATUS_RULES = [
    { status: "merged", selector: ".status-box-mr-merged, .status-box.status-box-merged" },
    { status: "open", selector: ".status-box-open, .status-box.status-box-open" },
    { status: "closed", selector: ".status-box-closed, .status-box.status-box-closed" },
    { status: "canceled", selector: ".status-box-canceled, .status-box.status-box-canceled, .status-box-mr-canceled" }
  ];
  var MR_TITLE_SELECTORS = [
    ".detail-page-header .title",
    ".merge-request-details .title",
    "[data-testid='title-content']",
    ".page-title"
  ];
  var MR_DESCRIPTION_SELECTORS = [
    ".detail-page-description .md",
    ".description .md",
    ".merge-request-details .md"
  ];
  var BUTTON_ACTION_SELECTORS = {
    approve: "[data-testid='approve-button'], [data-qa-selector='approve_button']",
    merge: "[data-testid='merge-button'], [data-qa-selector='merge_button']",
    submitReview: "[data-testid='submit-review-button'], [data-qa-selector='submit_review_button']"
  };
  var BUTTON_ACTION_KEYS = ["approve", "merge", "submitReview"];

  // Keep UI resilient when extension reload invalidates the runtime port.
  function safeSendMessage(msg, callback) {
    try {
      chrome.runtime.sendMessage(msg, callback);
    } catch (e) {
      removeButtons();
      showToast("Extension was reloaded. Please refresh the page.", true);
    }
  }

  var _worklogEnabled = false;
  var _autoOpenJira = false;
  var _jiraBaseUrl = "";
  var BUTTONS = [];

  function parseButtons(arr) {
    return (arr || []).map(function (b) {
      var branches = (b.branches || "").split(",").map(function (s) { return s.trim().toLowerCase(); }).filter(Boolean);
      var transitionName = (b.transitionName || "").trim();
      var targetStatus = (b.targetStatus || transitionName || b.label || "").trim();
      return {
        label: b.label || "",
        transitionName: transitionName || null,
        targetStatus: targetStatus,
        color: b.color || "rgb(99, 166, 233)",
        worklogComment: b.worklogComment || "",
        visibility: { status: (b.mrStatus || "open").toLowerCase(), branches: branches },
        autoTrigger: {
          approve: !!b.autoOnApprove,
          merge: !!b.autoOnMerge,
          submitReview: !!b.autoOnSubmitReview
        }
      };
    });
  }

  function loadConfig(callback) {
    chrome.storage.local.get(STORAGE_KEYS, function (data) {
      _worklogEnabled = !!data.worklogEnabled;
      _autoOpenJira = !!data.autoOpenJira;
      _jiraBaseUrl = (data.jiraBaseUrl || "").replace(/\/+$/, "");

      if (data.buttons && data.buttons.length > 0) {
        BUTTONS = parseButtons(data.buttons);
        callback();
      } else {
        fetch(chrome.runtime.getURL("src/defaults.json"))
          .then(function (r) { return r.json(); })
          .then(function (defs) { BUTTONS = parseButtons(defs.buttons); })
          .catch(function () { BUTTONS = []; })
          .finally(callback);
      }
    });
  }

  function getText(el) {
    return (el && el.textContent ? el.textContent : "").trim();
  }

  function getLowerText(el) {
    return getText(el).toLowerCase();
  }

  function findBySelectors(selectors) {
    for (var i = 0; i < selectors.length; i++) {
      var el = document.querySelector(selectors[i]);
      if (el) return el;
    }
    return null;
  }

  function detectMRStatus() {
    for (var i = 0; i < MR_STATUS_RULES.length; i++) {
      if (document.querySelector(MR_STATUS_RULES[i].selector)) return MR_STATUS_RULES[i].status;
    }

    var badges = document.querySelectorAll(".badge");
    for (var b = 0; b < badges.length; b++) {
      var t = getLowerText(badges[b]);
      if (t === "merged" || t === "open" || t === "closed" || t === "canceled") return t;
    }

    return null;
  }

  function detectTargetBranch() {
    var primary = document.querySelector(".js-target-branch");
    if (primary) return getLowerText(primary);

    var refs = document.querySelectorAll(".ref-name");
    if (refs.length >= 2) return getLowerText(refs[1]);

    var testEl = document.querySelector("[data-testid='target-branch-link']");
    if (testEl) return getLowerText(testEl);

    // Last /-/tree/ link (excluding "Repository" nav) is typically target branch
    var branchLinks = document.querySelectorAll("a[href*='/-/tree/']");
    for (var b = branchLinks.length - 1; b >= 0; b--) {
      var text = getText(branchLinks[b]);
      var normalized = text.toLowerCase();
      if (text && normalized !== "repository") return normalized;
    }

    return null;
  }

  var _visibilityTimer = null;
  var _visibilityRefreshTimer = null;
  var _visibilityRetries = 0;
  var _visibilityResolved = false;
  var _lastVisibleStatus = null;
  var _lastVisibleTargetBranch = null;

  function updateButtonVisibility(force) {
    var container = document.getElementById(CONTAINER_ID);
    if (!container) return;

    var status = detectMRStatus();
    var targetBranch = detectTargetBranch();

    if (!status || !targetBranch) {
      if (!_visibilityResolved && _visibilityRetries < STATUS_CHECK_RETRIES_MAX) {
        _visibilityRetries++;
        clearTimeout(_visibilityTimer);
        _visibilityTimer = setTimeout(updateButtonVisibility, STATUS_CHECK_RETRY_MS);
      } else if (!_visibilityResolved) {
        // GitLab can render MR metadata late; after retries we keep controls visible.
        _visibilityResolved = true;
        applyVisibility(container, null, null);
        setTimeout(updateWarningIndicators, WARNING_INDICATORS_DELAY_MS);
      }
      return;
    }

    _visibilityResolved = true;
    _visibilityRetries = 0;
    clearTimeout(_visibilityTimer);

    var prevStatus = _lastVisibleStatus;
    if (!force && _lastVisibleStatus === status && _lastVisibleTargetBranch === targetBranch) return;

    _lastVisibleStatus = status;
    _lastVisibleTargetBranch = targetBranch;
    applyVisibility(container, status, targetBranch);

    // Prevent false merge triggers from confirmation dialogs.
    if (status === "merged" && prevStatus !== "merged" && hasPendingMergeAutoTrigger()) {
      consumePendingMergeAutoTrigger();
      triggerAutoButtons("merge");
    }

    setTimeout(updateWarningIndicators, WARNING_INDICATORS_DELAY_MS);
  }

  function applyVisibility(container, status, targetBranch) {
    var btns = container.querySelectorAll("button[data-btn-label]");
    var anyVisible = false;

    for (var i = 0; i < btns.length; i++) {
      var label = btns[i].dataset.btnLabel;
      var def = findButtonDefByLabel(label);
      if (!def) continue;

      var show = isVisibleForMR(def, status, targetBranch);

      if (!def.transitionName && !_worklogEnabled) show = false;

      btns[i].style.display = show ? "" : "none";
      if (show) anyVisible = true;
    }

    container.style.display = anyVisible ? "inline-flex" : "none";
  }

  function resetVisibilityState() {
    _visibilityRetries = 0;
    _visibilityResolved = false;
    _lastVisibleStatus = null;
    _lastVisibleTargetBranch = null;
    _pendingMergeAutoTriggerUntil = 0;
    clearTimeout(_visibilityTimer);
    clearTimeout(_visibilityRefreshTimer);
  }

  function scheduleVisibilityRefresh() {
    clearTimeout(_visibilityRefreshTimer);
    _visibilityRefreshTimer = setTimeout(function () {
      updateButtonVisibility(false);
    }, VISIBILITY_REFRESH_DEBOUNCE_MS);
  }

  // Distribute totalMinutes across issues, each rounded up to nearest 5 (min 5).
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

  function getInnerTextBySelectors(selectors) {
    var el = findBySelectors(selectors);
    return el ? (el.innerText || "") : "";
  }

  function getMRContextText() {
    return getMRTitleText() + "\n" + getMRDescriptionText();
  }

  function getTargetStatus(def) {
    return def.targetStatus || def.transitionName || def.label;
  }

  function uniqueNonEmpty(values) {
    var out = [];
    var seen = {};
    for (var i = 0; i < values.length; i++) {
      var value = (values[i] || "").trim();
      if (!value || seen[value]) continue;
      seen[value] = true;
      out.push(value);
    }
    return out;
  }

  function getTargetStatusNames(def) {
    return uniqueNonEmpty([def.targetStatus, def.transitionName, def.label]);
  }

  function buildButtonTooltip(def) {
    var lines = [];
    if (def.transitionName) {
      lines.push("Move linked Jira issues to \"" + getTargetStatus(def) + "\" status");
    } else {
      lines.push("Log time without changing Jira issue status");
    }
    if (_worklogEnabled) lines.push("Log worklog: \"" + def.worklogComment + "\"");
    return lines.join("\n");
  }

  function findButtonDefByLabel(label) {
    for (var i = 0; i < BUTTONS.length; i++) {
      if (BUTTONS[i].label === label) return BUTTONS[i];
    }
    return null;
  }

  function matchesTargetBranch(def, targetBranch) {
    return !!(def && def.visibility && def.visibility.branches && def.visibility.branches.indexOf(targetBranch) !== -1);
  }

  function isVisibleForMR(def, status, targetBranch) {
    if (!def) return false;
    if (!status || !targetBranch) return true;
    return def.visibility.status === status && matchesTargetBranch(def, targetBranch);
  }

  function getMRDescriptionText() {
    return getInnerTextBySelectors(MR_DESCRIPTION_SELECTORS);
  }

  function getMRTitleText() {
    return getInnerTextBySelectors(MR_TITLE_SELECTORS);
  }

  function createButtonContainer() {
    var container = document.createElement("span");
    container.id = CONTAINER_ID;
    container.className = "jira-controls";

    var jiraLabel = document.createElement("span");
    jiraLabel.className = "jira-controls-label";
    jiraLabel.textContent = "Jira:";
    container.appendChild(jiraLabel);

    if (_worklogEnabled) {
      container.appendChild(createMinutesInput());
      var minLabel = document.createElement("span");
      minLabel.className = "jira-worklog-label";
      minLabel.textContent = "min to worklog";
      minLabel.title = WORKLOG_TOOLTIP;
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
    input.className = "jira-worklog-input";
    input.type = "number";
    input.min = "0";
    input.step = "5";
    input.value = "5";
    input.title = WORKLOG_TOOLTIP;
    return input;
  }

  function createSingleButton(def) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn gl-button btn-sm jira-btn jira-btn-transition";
    btn.style.backgroundColor = def.color;
    btn.dataset.btnLabel = def.label;
    btn.style.display = "none";

    btn.title = buildButtonTooltip(def);

    var textSpan = document.createElement("span");
    textSpan.className = "gl-button-text";
    textSpan.textContent = def.label;
    btn.appendChild(textSpan);

    var warningIndicator = document.createElement("span");
    warningIndicator.className = "jira-warn-badge";
    warningIndicator.textContent = "!";
    warningIndicator.title = "Some tasks may already be in the target status";
    btn.appendChild(warningIndicator);

    btn.addEventListener("click", handleButtonClick.bind(null, btn, def));
    return btn;
  }

  function setAllButtonsDisabled(disabled) {
    var container = document.getElementById(CONTAINER_ID);
    if (!container) return;
    var btns = container.querySelectorAll("button[data-btn-label]");
    for (var i = 0; i < btns.length; i++) {
      btns[i].disabled = disabled;
      btns[i].classList.toggle("jira-btn--disabled", disabled);
    }
  }

  function showActionError(message) {
    showToast(message, true);
    setAllButtonsDisabled(false);
  }

  function hasRuntimeOrEmptyResponseError(response) {
    if (chrome.runtime.lastError) {
      showActionError("Extension error: " + chrome.runtime.lastError.message);
      return true;
    }
    if (!response) {
      showActionError("No response from background.");
      return true;
    }
    return false;
  }

  function handleButtonClick(btn, def) {
    if (!def.transitionName) {
      executeJiraAction(btn, def);
      return;
    }

    setAllButtonsDisabled(true);
    
    var issueKeys = extractJiraKeys(getMRContextText());
    var targetStatusName = getTargetStatus(def);
    var targetStatusNames = getTargetStatusNames(def);

    if (issueKeys.length === 0) {
      showToast("No Jira issue keys found in MR description / title.", true);
      setAllButtonsDisabled(false);
      return;
    }

    safeSendMessage(
      {
        action: "checkIssueStatuses",
        issueKeys: issueKeys,
        targetStatus: targetStatusName,
        targetStatuses: targetStatusNames
      },
      function (response) {
        if (hasRuntimeOrEmptyResponseError(response)) return;

        if (response.errors && response.errors.length > 0) {
          return showActionError("Status check failed: " + response.errors.join(", "));
        }

        if (response.allInTargetStatus) {
          var alreadyInStatus = response.statuses.map(function (s) { return s.issueKey; }).join(", ");
          showWarningDialog(
            "All Issues Already in Target Status",
            "All linked issues are already in '" + targetStatusName + "' status:\\n" + alreadyInStatus + "\\n\\nDo you want to proceed anyway?",
            function () { executeJiraAction(btn, def); },
            function () { setAllButtonsDisabled(false); }
          );
          return;
        }

        var alreadyInTarget = response.statuses.filter(function (s) { return s.isInTargetStatus; });
        if (alreadyInTarget.length > 0) {
          var alreadyInKeys = alreadyInTarget.map(function (s) { return s.issueKey; }).join(", ");
          var notInTarget = response.statuses.filter(function (s) { return !s.isInTargetStatus; });
          var notInKeys = notInTarget.map(function (s) { return s.issueKey + " (" + s.currentStatus + ")"; }).join(", ");
          
          showWarningDialog(
            "Some Issues Already in Target Status",
            "Some issues are already in '" + targetStatusName + "' status:\\n" + alreadyInKeys + 
            "\\n\\nIssues that will be transitioned:\\n" + notInKeys + "\\n\\nDo you want to proceed?",
            function () { executeJiraAction(btn, def); },
            function () { setAllButtonsDisabled(false); }
          );
          return;
        }

        executeJiraAction(btn, def);
      }
    );
  }

  function executeJiraAction(btn, def) {
    setAllButtonsDisabled(true);

    var issueKeys = extractJiraKeys(getMRContextText());

    if (issueKeys.length === 0) {
      showToast("No Jira issue keys found in MR description / title.", true);
      setAllButtonsDisabled(false);
      return;
    }

    var worklogs = [];
    if (_worklogEnabled) {
      var minutesInput = document.getElementById("jira-worklog-minutes");
      var totalMinutes = parseInt(minutesInput ? minutesInput.value : "5", 10) || 0;
      if (totalMinutes > 0) {
        var allocations = distributeMinutes(totalMinutes, issueKeys.length);
        worklogs = issueKeys.map(function (key, idx) {
          return { issueKey: key, minutes: allocations[idx], comment: def.worklogComment };
        });
      }
    }

    safeSendMessage(
      {
        action: "processJiraAction",
        issueKeys: issueKeys,
        transitionName: def.transitionName,
        worklogs: worklogs
      },
      function (response) {
        if (hasRuntimeOrEmptyResponseError(response)) return;

        var parts = [];
        if (response.success > 0) parts.push("\u2713 " + def.label + " \u2014 Success: " + response.success);
        if (response.failed > 0)  parts.push("Failed: " + response.failed);
        if (response.errors && response.errors.length) parts.push("\n" + response.errors.join("\n"));
        showToast(parts.join(" | "), response.failed > 0);

        if (_autoOpenJira && _jiraBaseUrl) {
          safeSendMessage({
            action: "openJiraTabs",
            urls: issueKeys.map(function (key) { return _jiraBaseUrl + "/browse/" + key; })
          });
        }
        
        setAllButtonsDisabled(false);
      }
    );
  }

  function showToast(msg, isError) {
    var toast = document.createElement("div");
    toast.className = "jira-toast " + (isError ? "jira-toast--err" : "jira-toast--ok");
    toast.textContent = msg;
    document.body.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = "0";
      setTimeout(function () { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 400);
    }, 6000);
  }

  function showWarningDialog(title, message, onConfirm, onCancel) {
    var overlay = document.createElement("div");
    overlay.className = "jira-dialog-overlay";

    var dialog = document.createElement("div");
    dialog.className = "jira-dialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.innerHTML =
      "<h3></h3><p></p><div class='jira-dialog-actions'>" +
      "<button class='jira-dialog-btn jira-dialog-btn--cancel'>Cancel</button>" +
      "<button class='jira-dialog-btn jira-dialog-btn--confirm'>Proceed</button></div>";
    dialog.querySelector("h3").textContent = title;
    dialog.querySelector("p").textContent = message.replace(/\\n/g, "\n");

    var doCancel = function () { cleanup(); if (onCancel) onCancel(); };
    var cleanup = function () {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
    var onKey = function (e) {
      if (e.key === "Escape") { e.stopPropagation(); doCancel(); }
    };

    var prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    document.addEventListener("keydown", onKey);

    dialog.querySelector(".jira-dialog-btn--cancel").addEventListener("click", doCancel);
    dialog.querySelector(".jira-dialog-btn--confirm").addEventListener("click", function () { cleanup(); if (onConfirm) onConfirm(); });
    overlay.addEventListener("click", function (e) { if (e.target === overlay) doCancel(); });

    overlay.appendChild(dialog);
    document.body.appendChild(overlay);
    dialog.querySelector(".jira-dialog-btn--confirm").focus();
  }

  function updateWarningIndicators() {
    var container = document.getElementById(CONTAINER_ID);
    if (!container) return;

    var issueKeys = extractJiraKeys(getMRContextText());

    if (issueKeys.length === 0) return;

    var btns = container.querySelectorAll("button[data-btn-label]");
    for (var i = 0; i < btns.length; i++) {
      var btn = btns[i];
      var def = findButtonDefByLabel(btn.dataset.btnLabel);
      if (!def) continue;
      var transitionName = def.transitionName;
      var targetStatus = getTargetStatus(def);
      var targetStatusNames = getTargetStatusNames(def);
      
      if (!transitionName) continue;

      safeSendMessage(
        {
          action: "checkIssueStatuses",
          issueKeys: issueKeys,
          targetStatus: targetStatus,
          targetStatuses: targetStatusNames
        },
        (function (button) {
          return function (response) {
            if (!response || response.errors) return;
            
            var indicator = button.querySelector(".jira-warn-badge");
            if (!indicator) return;

            var hasIssuesInTarget = response.statuses && response.statuses.some(function (s) {
              return s.isInTargetStatus;
            });

            indicator.style.display = hasIssuesInTarget ? "block" : "none";
          };
        })(btn)
      );
    }
  }

  var _pendingMergeAutoTriggerUntil = 0;
  var _lastAutoTriggerTs = { approve: 0, merge: 0, submitReview: 0 };

  // Merge click may open confirmation modals; trigger only after MR status becomes merged.
  function markPendingMergeAutoTrigger() {
    _pendingMergeAutoTriggerUntil = Date.now() + MERGE_PENDING_TTL_MS;
  }

  function hasPendingMergeAutoTrigger() {
    return Date.now() <= _pendingMergeAutoTriggerUntil;
  }

  function consumePendingMergeAutoTrigger() {
    _pendingMergeAutoTriggerUntil = 0;
  }

  function detectGitLabAction(target) {
    if (!target || !target.closest) return null;

    var control = target.closest("button, [role='button'], input[type='submit']");
    if (!control) return null;
    if (control.closest(CONTAINER_SELECTOR)) return null;

    for (var i = 0; i < BUTTON_ACTION_KEYS.length; i++) {
      var action = BUTTON_ACTION_KEYS[i];
      if (control.matches(BUTTON_ACTION_SELECTORS[action])) return action;
    }

    var text = (control.textContent || control.value || "").trim().toLowerCase();
    if (text === "approve") return "approve";
    if (text.indexOf("submit review") !== -1) return "submitReview";
    if (text === "merge" || text.indexOf("merge ") === 0 || text.indexOf("merge immediately") !== -1) return "merge";

    return null;
  }

  function triggerAutoButtons(action) {
    var now = Date.now();
    if (now - (_lastAutoTriggerTs[action] || 0) < AUTO_TRIGGER_COOLDOWN_MS) return;
    _lastAutoTriggerTs[action] = now;

    // Auto actions bypass status filters, but must respect target-branch rules.
    var targetBranch = detectTargetBranch() || _lastVisibleTargetBranch;
    if (!targetBranch) return;

    var matched = BUTTONS.filter(function (def) {
      return def.autoTrigger &&
        def.autoTrigger[action] &&
        matchesTargetBranch(def, targetBranch);
    });
    if (!matched.length) return;

    for (var i = 0; i < matched.length; i++) {
      (function (def, idx) {
        setTimeout(function () {
          handleButtonClick(null, def);
        }, idx * AUTO_TRIGGER_STEP_DELAY_MS);
      })(matched[i], i);
    }
  }

  function onGitLabActionClick(e) {
    if (!isMRPage()) return;
    var action = detectGitLabAction(e.target);
    if (!action) return;

    setTimeout(function () {
      if (!isMRPage()) return;
      if (action === "merge") {
        markPendingMergeAutoTrigger();
        return;
      }
      triggerAutoButtons(action);
    }, CLICK_ACTION_DELAY_MS);
  }

  function isMRPage() {
    return MR_PATH_RE.test(window.location.pathname);
  }

  function injectButtons() {
    if (!isMRPage()) { removeButtons(); return; }
    if (document.getElementById(CONTAINER_ID)) return;

    var target = findInjectionTarget();
    if (target) {
      target.appendChild(createButtonContainer());
      updateButtonVisibility(true);
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

  var lastUrl = window.location.href;

  function startObserver() {
    document.addEventListener("click", onGitLabActionClick, true);

    var observer = new MutationObserver(function () {
      if (window.location.href !== lastUrl) {
        lastUrl = window.location.href;
        removeButtons();
        resetVisibilityState();
        setTimeout(injectButtons, SPA_NAVIGATION_INJECT_DELAY_MS);
      }
      if (isMRPage()) {
        if (!document.getElementById(CONTAINER_ID)) {
          injectButtons();
        } else {
          scheduleVisibilityRefresh();
        }
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    injectButtons();
  }

  loadConfig(startObserver);
})();
