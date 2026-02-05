// content.js — Content script injected into GitLab MR pages

(function () {
  "use strict";

  var CONTAINER_ID = "jira-status-mover-container";
  var MR_PATH_RE = /\/merge_requests\/\d+/;

  // Button definitions: label shown on the button, Jira transition name, CSS color
  var BUTTONS = [
    { label: "Bugfix",        transitionName: "bugfix",        color: "rgb(83, 46, 22)"  },
    { label: "Internal Test", transitionName: "internal test", color: "rgb(99, 166, 233)" },
    { label: "Test Control",  transitionName: "test control",  color: "rgb(99, 166, 233)" },
    { label: "Done",          transitionName: "done",          color: "rgb(99, 166, 233)" }
  ];

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

  function createButtonContainer() {
    var container = document.createElement("span");
    container.id = CONTAINER_ID;
    container.style.display = "inline-flex";
    container.style.gap = "6px";
    container.style.marginLeft = "auto";
    container.style.flexWrap = "wrap";
    container.style.alignItems = "center";

    // "Jira:" label before the buttons
    var jiraLabel = document.createElement("span");
    jiraLabel.textContent = "Jira:";
    jiraLabel.style.fontWeight = "600";
    jiraLabel.style.fontSize = "13px";
    jiraLabel.style.color = "#333";
    container.appendChild(jiraLabel);

    BUTTONS.forEach(function (def) {
      var btn = createSingleButton(def);
      container.appendChild(btn);
    });

    return container;
  }

  function createSingleButton(def) {
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "btn gl-button btn-sm";
    btn.style.backgroundColor = def.color;
    btn.style.color = "#fff";
    btn.style.border = "none";
    btn.style.cursor = "pointer";
    btn.dataset.transitionName = def.transitionName;

    var textSpan = document.createElement("span");
    textSpan.className = "gl-button-text";
    textSpan.textContent = def.label;
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
        resetButton(btn, def.label);
        return;
      }

      chrome.runtime.sendMessage(
        {
          "action": "transitionJiraIssue",
          "issueKeys": issueKeys,
          "transitionName": def.transitionName
        },
        function (response) {
          if (chrome.runtime.lastError) {
            showToast("Extension error: " + chrome.runtime.lastError.message, true);
            resetButton(btn, def.label);
            return;
          }
          if (!response) {
            showToast("No response from background.", true);
            resetButton(btn, def.label);
            return;
          }

          var parts = [];
          if (response.success > 0) {
            parts.push("✓ " + def.label + " — Success: " + response.success);
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

  function resetButton(btn, label) {
    btn.disabled = false;
    var span = btn.querySelector(".gl-button-text");
    if (span) {
      span.textContent = label;
    }
    btn.style.opacity = "1";
    btn.style.cursor = "pointer";
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

  function injectButtons() {
    if (!isMRPage()) {
      removeButtons();
      return;
    }
    if (document.getElementById(CONTAINER_ID)) {
      return; // already injected
    }

    // Find the outermost media-body flex container and append to it
    // so margin-left:auto pushes the buttons to the far right edge
    var summaryRow = document.querySelector("[data-testid='approvals-summary-content']");
    if (summaryRow) {
      // media-body is the top-level full-width flex container
      var mediaBody = summaryRow.closest(".media-body");
      if (mediaBody) {
        mediaBody.appendChild(createButtonContainer());
        return;
      }
    }

    // Fallback: try approve button's grandparent (media-body level)
    var approveBtn = document.querySelector("[data-testid='approve-button']");
    if (approveBtn) {
      var mediaBody = approveBtn.closest(".media-body");
      if (mediaBody) {
        mediaBody.appendChild(createButtonContainer());
        return;
      }
      approveBtn.parentNode.appendChild(createButtonContainer());
      return;
    }

    // Approvals section exists but no approve button yet — place inside action area
    var approvalsSection = document.querySelector(".js-mr-approvals");
    if (approvalsSection) {
      // Try action buttons area
      var actions = approvalsSection.querySelector(".state-container-action-buttons");
      if (actions) {
        actions.prepend(createButtonContainer());
        return;
      }
      // Any mr-widget-body inside approvals
      var widgetBody = approvalsSection.querySelector(".mr-widget-body");
      if (widgetBody) {
        widgetBody.appendChild(createButtonContainer());
        return;
      }
    }

    // Do NOT fall back to header — MutationObserver will retry when
    // the approvals widget renders.
  }

  function removeButtons() {
    var container = document.getElementById(CONTAINER_ID);
    if (container && container.parentNode) {
      container.parentNode.removeChild(container);
    }
  }

  // ---- MutationObserver for SPA navigation ----

  var lastUrl = window.location.href;

  function onUrlChange() {
    if (window.location.href !== lastUrl) {
      lastUrl = window.location.href;
      removeButtons();
      // Small delay to let GitLab render the new page
      setTimeout(injectButtons, 800);
    }
  }

  var observer = new MutationObserver(function () {
    onUrlChange();
    // Also try inject if we are on MR page but buttons are missing (DOM re-render)
    if (isMRPage() && !document.getElementById(CONTAINER_ID)) {
      injectButtons();
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true
  });

  // Initial injection
  injectButtons();
})();
