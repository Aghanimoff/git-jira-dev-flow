// options.js - Git&Jira deroutine Dev Flow

(() => {
  "use strict";

  const STATUS_OPTIONS = ["open", "merged", "closed"];
  const STORAGE_KEYS = [
    "jiraBaseUrl",
    "username",
    "password",
    "worklogEnabled",
    "autoOpenJira",
    "buttons"
  ];

  const jiraBaseUrlInput = document.getElementById("jiraBaseUrl");
  const usernameInput = document.getElementById("username");
  const passwordInput = document.getElementById("password");
  const worklogCheckbox = document.getElementById("worklogEnabled");
  const autoOpenCheckbox = document.getElementById("autoOpenJira");
  const saveButtons = Array.from(document.querySelectorAll("[data-save-settings]"));
  const addBtn = document.getElementById("addBtn");
  const buttonsList = document.getElementById("buttons-list");
  const statusElements = [
    document.getElementById("status"),
    document.getElementById("statusButtons")
  ].filter(Boolean);
  const connStatusEl = document.getElementById("connStatus");

  const tabButtons = Array.from(document.querySelectorAll(".tab-btn"));
  const tabContents = {
    general: document.getElementById("tab-general"),
    buttons: document.getElementById("tab-buttons")
  };

  let defaultsCache = null;
  let autoSaveTimer = null;
  const AUTO_SAVE_DELAY = 700;

  function setActiveTab(tabName) {
    tabButtons.forEach((button) => {
      button.classList.toggle("active", button.dataset.tab === tabName);
    });

    Object.keys(tabContents).forEach((name) => {
      tabContents[name].hidden = name !== tabName;
    });
  }

  tabButtons.forEach((button) => {
    button.addEventListener("click", () => setActiveTab(button.dataset.tab));
  });
  setActiveTab("general");

  function loadDefaults(callback) {
    if (defaultsCache) {
      callback(defaultsCache);
      return;
    }

    fetch(chrome.runtime.getURL("src/defaults.json"))
      .then((response) => response.json())
      .then((data) => {
        defaultsCache = data;
        callback(defaultsCache);
      })
      .catch(() => {
        defaultsCache = { buttons: [] };
        callback(defaultsCache);
      });
  }

  function createCell(element) {
    const td = document.createElement("td");
    td.appendChild(element);
    return td;
  }

  function appendCells(row, elements) {
    elements.forEach((element) => row.appendChild(createCell(element)));
  }

  function createInput(className, value, placeholder) {
    const input = document.createElement("input");
    input.className = className;
    input.value = value || "";
    if (placeholder) {
      input.placeholder = placeholder;
    }
    return input;
  }

  function createCheckbox(className, checked) {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.className = className;
    input.checked = !!checked;
    return input;
  }

  function createStatusSelect(value) {
    const select = document.createElement("select");
    select.className = "bf-status";

    STATUS_OPTIONS.forEach((optionValue) => {
      const option = document.createElement("option");
      option.value = optionValue;
      option.textContent = optionValue;
      select.appendChild(option);
    });

    select.value = STATUS_OPTIONS.includes(value) ? value : "open";
    return select;
  }

  function createRemoveButton(onClick) {
    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "btn-remove";
    removeBtn.title = "Remove";
    removeBtn.textContent = "x";
    removeBtn.addEventListener("click", onClick);
    return removeBtn;
  }

  function createButtonRow(button = {}) {
    const tr = document.createElement("tr");

    const labelInput = createInput("bf-label", button.label, "Label");
    const transitionInput = createInput("bf-transition", button.transitionName, "Transition");

    const colorInput = createInput("bf-color", rgbToHex(button.color || "#555555"));
    colorInput.type = "color";

    const worklogInput = createInput("bf-comment", button.worklogComment, "Worklog");
    const statusSelect = createStatusSelect(button.mrStatus);
    const branchesInput = createInput("bf-branches", button.branches, "Branches");
    const autoApproveInput = createCheckbox("bf-auto-approve", button.autoOnApprove);
    const autoMergeInput = createCheckbox("bf-auto-merge", button.autoOnMerge);
    const autoReviewInput = createCheckbox("bf-auto-review", button.autoOnSubmitReview);

    appendCells(tr, [
      labelInput,
      transitionInput,
      colorInput,
      worklogInput,
      statusSelect,
      branchesInput,
      autoApproveInput,
      autoMergeInput,
      autoReviewInput
    ]);

    const removeCell = document.createElement("td");
    removeCell.appendChild(createRemoveButton(() => {
      tr.remove();
      scheduleAutoSave();
    }));
    tr.appendChild(removeCell);

    return tr;
  }

  function renderButtons(buttons) {
    buttonsList.textContent = "";
    (buttons || []).forEach((button) => {
      buttonsList.appendChild(createButtonRow(button));
    });
  }

  function readButtonRows() {
    const rows = Array.from(buttonsList.querySelectorAll("tr"));
    const buttons = [];

    const readText = (row, selector) => row.querySelector(selector).value.trim();
    const readChecked = (row, selector) => row.querySelector(selector).checked;

    rows.forEach((row) => {
      const label = readText(row, ".bf-label");
      if (!label) {
        return;
      }

      buttons.push({
        label,
        transitionName: readText(row, ".bf-transition"),
        color: hexToRgb(row.querySelector(".bf-color").value),
        worklogComment: readText(row, ".bf-comment"),
        mrStatus: row.querySelector(".bf-status").value,
        branches: readText(row, ".bf-branches"),
        autoOnApprove: readChecked(row, ".bf-auto-approve"),
        autoOnMerge: readChecked(row, ".bf-auto-merge"),
        autoOnSubmitReview: readChecked(row, ".bf-auto-review")
      });
    });

    return buttons;
  }

  function rgbToHex(color) {
    if (!color) {
      return "#555555";
    }

    if (color.charAt(0) === "#") {
      return color.length === 4
        ? "#" + color[1] + color[1] + color[2] + color[2] + color[3] + color[3]
        : color;
    }

    const parts = color.match(/\d+/g);
    if (!parts || parts.length < 3) {
      return "#555555";
    }

    const r = Number(parts[0]).toString(16).padStart(2, "0");
    const g = Number(parts[1]).toString(16).padStart(2, "0");
    const b = Number(parts[2]).toString(16).padStart(2, "0");
    return `#${r}${g}${b}`;
  }

  function hexToRgb(hex) {
    const normalized = rgbToHex(hex);
    const r = parseInt(normalized.slice(1, 3), 16);
    const g = parseInt(normalized.slice(3, 5), 16);
    const b = parseInt(normalized.slice(5, 7), 16);
    return `rgb(${r}, ${g}, ${b})`;
  }

  function flash(message, isError) {
    statusElements.forEach((statusEl) => {
      statusEl.textContent = message;
      statusEl.style.color = isError ? "#d9534f" : "#2da160";
    });
    setTimeout(() => {
      statusElements.forEach((statusEl) => {
        statusEl.textContent = "";
      });
    }, 2500);
  }

  function setConnStatus(state, message) {
    connStatusEl.textContent = "";
    if (!state) {
      return;
    }

    const dot = document.createElement("span");
    dot.className = `conn-dot ${state}`;

    const text = document.createElement("span");
    text.textContent = message;

    connStatusEl.appendChild(dot);
    connStatusEl.appendChild(text);
  }

  function testJiraConnection() {
    const baseUrl = jiraBaseUrlInput.value.trim().replace(/\/+$/, "");
    const username = usernameInput.value.trim();
    const password = passwordInput.value;

    if (!baseUrl || !username || !password) {
      setConnStatus("fail", "Fill in URL, username and password first.");
      return;
    }

    setConnStatus("loading", "Connecting...");

    fetch(`${baseUrl}/rest/api/2/myself`, {
      method: "GET",
      headers: {
        Authorization: "Basic " + btoa(`${username}:${password}`),
        "Content-Type": "application/json"
      }
    })
      .then((response) => {
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then((data) => {
        setConnStatus("ok", `Connected as ${data.displayName || data.name || username}`);
      })
      .catch((error) => {
        setConnStatus("fail", `Connection failed: ${error.message}`);
      });
  }

  function getSettingsPayload() {
    return {
      jiraBaseUrl: jiraBaseUrlInput.value.trim(),
      username: usernameInput.value.trim(),
      password: passwordInput.value,
      worklogEnabled: worklogCheckbox.checked,
      autoOpenJira: autoOpenCheckbox.checked,
      buttons: readButtonRows()
    };
  }

  function saveSettings(options = {}) {
    const settings = getSettingsPayload();
    const showMessage = !!options.showMessage;
    const message = options.message || "Settings saved!";
    const runConnectionTest = !!options.runConnectionTest;
    const isReadyForConnectionTest = !!(settings.jiraBaseUrl && settings.username && settings.password);

    chrome.storage.local.set(settings, () => {
      if (showMessage) {
        flash(message, false);
      }
      if (runConnectionTest && isReadyForConnectionTest) {
        testJiraConnection();
      }
    });
  }

  function clearAutoSaveTimer() {
    if (!autoSaveTimer) {
      return;
    }
    clearTimeout(autoSaveTimer);
    autoSaveTimer = null;
  }

  function scheduleAutoSave() {
    clearAutoSaveTimer();
    autoSaveTimer = setTimeout(() => {
      saveSettings();
      autoSaveTimer = null;
    }, AUTO_SAVE_DELAY);
  }

  function loadSettings(defaults) {
    chrome.storage.local.get(STORAGE_KEYS, (data) => {
      jiraBaseUrlInput.value = data.jiraBaseUrl || "";
      usernameInput.value = data.username || "";
      passwordInput.value = data.password || "";
      worklogCheckbox.checked = !!data.worklogEnabled;
      autoOpenCheckbox.checked = !!data.autoOpenJira;
      renderButtons(Array.isArray(data.buttons) ? data.buttons : defaults.buttons);
    });
  }

  addBtn.addEventListener("click", () => {
    buttonsList.appendChild(
      createButtonRow({
        color: "rgb(99, 166, 233)",
        mrStatus: "merged"
      })
    );
    scheduleAutoSave();
  });

  saveButtons.forEach((button) => {
    button.addEventListener("click", () => {
      clearAutoSaveTimer();
      saveSettings({ showMessage: true, runConnectionTest: true });
    });
  });

  [jiraBaseUrlInput, usernameInput, passwordInput].forEach((input) => {
    input.addEventListener("input", scheduleAutoSave);
  });
  [worklogCheckbox, autoOpenCheckbox].forEach((checkbox) => {
    checkbox.addEventListener("change", scheduleAutoSave);
  });
  buttonsList.addEventListener("input", scheduleAutoSave);
  buttonsList.addEventListener("change", scheduleAutoSave);

  loadDefaults(loadSettings);
})();

