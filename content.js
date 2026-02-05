// content.js — Content script injected into GitLab MR pages

(function () {
  "use strict";

  var BUTTON_ID = "jira-bugfix-mover-btn";
  var MR_PATH_RE = /\/merge_requests\/\d+/;

  // ---- URL / key detection ----

  var JIRA_URL_RE = /https?:\/\/[^\s\/]+\/browse\/([A-Z][A-Z0-9_]+-\d+)/gi;
  var JIRA_KEY_RE = /\b([A-Z][A-Z0-9_]+-\d+)\b/g;

  function extractJiraKeys(text) {
    var keys = {};
    var m;

    JIRA_URL_RE.lastIndex = 0;
    while ((m = JIRA_URL_RE.exec(text)) !== null) {
      keys[m[1].toUpperCase()] = true;
    }

    JIRA_KEY_RE.lastIndex = 0;
    while ((m = JIRA_KEY_RE.exec(text)) !== null) {
      keys[m[1].toUpperCase()] = true;
    }

    return Object.keys(keys);
  }

  // ---- Read MR description from DOM ----

  function getMRDescriptionText() {
    // GitLab renders the MR description inside .description .md
    var descEl = document.querySelector(".detail-page-description .md") ||
                 document.querySelector(".description .md") ||
                 document.querySelector(".merge-request-details .md");
    if (descEl) {
      return descEl.innerText || "";
    }
    return "";
  }

  // Also check the MR title
  function getMRTitleText() {
    var titleEl = document.querySelector(".detail-page-header .title") ||
                  document.querySelector(".merge-request-details .title") ||
                  document.querySelector("[data-testid='title-content']") ||
                  document.querySelector(".page-title");
    if (titleEl) {
      return titleEl.innerText || "";
    }
    return "";
  }

  // ---- Button creation ----

  function createButton() {
    var btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.type = "button";
    btn.className = "btn gl-button btn-confirm btn-sm";
    btn.style.marginLeft = "8px";

    var textSpan = document.createElement("span");
    textSpan.className = "gl-button-text";
    textSpan.textContent = "Jira → bugfix";
    btn.appendChild(textSpan);

    btn.addEventListener("click", function () {
      btn.disabled = true;
      textSpan.textContent = "Processing…";
      btn.style.opacity = "0.6";
      btn.style.cursor = "default";

      var text = getMRTitleText() + "\n" + getMRDescriptionText();
      var issueKeys = extractJiraKeys(text);

      if (issueKeys.length === 0) {
        showToast("No Jira issue keys found in MR description / title.", true);
        resetButton(btn);
        return;
      }

      chrome.runtime.sendMessage(
        { "action": "moveToJiraBugfix", "issueKeys": issueKeys },
        function (response) {
          if (chrome.runtime.lastError) {
            showToast("Extension error: " + chrome.runtime.lastError.message, true);
            resetButton(btn);
            return;
          }
          if (!response) {
            showToast("No response from background.", true);
            resetButton(btn);
            return;
          }

          var parts = [];
          if (response.success > 0) {
            parts.push("Success: " + response.success);
          }
          if (response.failed > 0) {
            parts.push("Failed: " + response.failed);
          }
          if (response.errors && response.errors.length > 0) {
            parts.push("\n" + response.errors.join("\n"));
          }

          showToast(parts.join(" | "), response.failed > 0);
          // keep button disabled after action — one-shot
        }
      );
    });

    return btn;
  }

  function resetButton(btn) {
    btn.disabled = false;
    var span = btn.querySelector(".gl-button-text");
    if (span) {
      span.textContent = "Jira → bugfix";
    }
    btn.style.opacity = "1";
    btn.style.cursor = "";
  }

  // ---- Toast notification ----

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
        if (toast.parentNode) {
          toast.parentNode.removeChild(toast);
        }
      }, 400);
    }, 6000);
  }

  // ---- Injection logic (SPA-aware) ----

  function isMRPage() {
    return MR_PATH_RE.test(window.location.pathname);
  }

  function injectButton() {
    if (!isMRPage()) {
      removeButton();
      return;
    }
    if (document.getElementById(BUTTON_ID)) {
      return; // already injected
    }

    // Primary: insert right after the Approve / Revoke approval button
    var approveBtn = document.querySelector("[data-testid='approve-button']");
    if (approveBtn) {
      approveBtn.parentNode.insertBefore(createButton(), approveBtn.nextSibling);
      return;
    }

    // Approvals section exists but no approve button yet — place inside action area
    var approvalsSection = document.querySelector(".js-mr-approvals");
    if (approvalsSection) {
      // Try the row with approve summary
      var summaryRow = approvalsSection.querySelector("[data-testid='approvals-summary-content']");
      if (summaryRow) {
        summaryRow.appendChild(createButton());
        return;
      }
      // Try action buttons area
      var actions = approvalsSection.querySelector(".state-container-action-buttons");
      if (actions) {
        actions.prepend(createButton());
        return;
      }
      // Any mr-widget-body inside approvals
      var widgetBody = approvalsSection.querySelector(".mr-widget-body");
      if (widgetBody) {
        widgetBody.appendChild(createButton());
        return;
      }
    }

    // Do NOT fall back to header — MutationObserver will retry when
    // the approvals widget renders.
  }

  function removeButton() {
    var btn = document.getElementById(BUTTON_ID);
    if (btn && btn.parentNode) {
      btn.parentNode.removeChild(btn);
    }
  }

  // ---- MutationObserver for SPA navigation ----

  var lastUrl = window.location.href;

  function onUrlChange() {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      removeButton();
      // Small delay to let GitLab render the new page
      setTimeout(injectButton, 800);
    }
  }

  var observer = new MutationObserver(function () {
    onUrlChange();
    // Also try inject if we are on MR page but button is missing (DOM re-render)
    if (isMRPage() && !document.getElementById(BUTTON_ID)) {
      injectButton();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Initial injection
  injectButton();
})();
