function timestamp(value) {
  if (!value) return "Not synced yet";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Unknown" : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function button(node, className, text) {
  const control = node("button", `button ${className}`, text);
  control.type = "button";
  return control;
}

let connectPollTimer = null;
const CONNECT_POLL_MS = 3000;
const CONNECT_POLL_LIMIT_MS = 2 * 60 * 1000;

function stopConnectPolling() {
  if (connectPollTimer) window.clearInterval(connectPollTimer);
  connectPollTimer = null;
}

/** Polls /api/state until Google Health reports connected, the view is gone, or two minutes pass. */
function pollForConnection({ refresh, toast }) {
  stopConnectPolling();
  const startedAt = Date.now();
  let checking = false;
  connectPollTimer = window.setInterval(async () => {
    if (checking) return;
    if (!document.querySelector(".settings-view") || Date.now() - startedAt > CONNECT_POLL_LIMIT_MS) { stopConnectPolling(); return; }
    checking = true;
    try {
      const next = await refresh();
      if (next?.settings?.googleHealth?.connected) {
        stopConnectPolling();
        toast("Google Health connected", "Sync from the Metrics dashboard to import your data.");
      }
    } catch { /* keep polling until the limit */ }
    finally { checking = false; }
  }, CONNECT_POLL_MS);
}

function googleHealthPanel(ctx) {
  const { state, node, add, api, refresh, toast } = ctx;
  const google = state.settings?.googleHealth || { hasClient: false, connected: false, lastSync: null };
  const panel = node("section", "panel google-panel");
  const header = node("header", "panel-header");
  const copy = node("div", "");
  add(copy, node("h2", "", "Google Health"), node("p", "", google.connected ? "Connected. Metrics sync reads activity, heart, sleep, and body data." : "Import daily health metrics from your Google Health or Fitbit account."));
  header.append(copy);
  panel.append(header);

  const form = node("form", "google-form");
  form.noValidate = true;
  const idField = node("div", "field");
  const idLabel = node("label", "", "Google OAuth client ID");
  const clientId = node("input", "input");
  clientId.id = "google-client-id"; clientId.name = "googleClientId"; clientId.type = "text"; clientId.autocomplete = "off"; clientId.spellcheck = false;
  clientId.placeholder = google.hasClient ? "Saved locally — leave blank to keep it" : "1234567890-abc.apps.googleusercontent.com";
  idLabel.htmlFor = clientId.id;
  add(idField, idLabel, clientId);

  const secretField = node("div", "field");
  const secretLabel = node("label", "", "Google OAuth client secret");
  const clientSecret = node("input", "input");
  clientSecret.id = "google-client-secret"; clientSecret.name = "googleClientSecret"; clientSecret.type = "password"; clientSecret.autocomplete = "off"; clientSecret.spellcheck = false;
  clientSecret.placeholder = google.hasClient ? "Saved locally — leave blank to keep it" : "Paste the client secret";
  secretLabel.htmlFor = clientSecret.id;
  const hint = node("p", "field-hint");
  const link = node("a", "", "Google Cloud credentials");
  link.href = "https://console.cloud.google.com/apis/credentials"; link.target = "_blank"; link.rel = "noreferrer";
  add(hint,
    document.createTextNode("Create a Desktop app OAuth client in "),
    link,
    document.createTextNode(", enable the Google Health API, and add yourself as a test user. Credentials and tokens stay in your local data folder."),
  );
  add(secretField, secretLabel, clientSecret, hint);

  const actions = node("div", "google-actions");
  const save = button(node, "primary", "Save Google client");
  save.type = "submit";
  const connect = button(node, "secondary", "Connect Google Health");
  connect.disabled = !google.hasClient;
  connect.title = google.hasClient ? "Sign in with Google in a new tab" : "Save a client ID and secret first";
  connect.addEventListener("click", async () => {
    connect.disabled = true;
    try {
      const result = await api("/api/metrics/google/connect", { method: "POST", body: "{}" });
      if (!result?.url) throw new Error("The server did not return a sign-in link.");
      window.open(result.url, "_blank", "noopener");
      toast("Finish signing in with Google in the new tab", "Corpus will notice once access is granted.");
      pollForConnection({ refresh, toast });
    } catch (error) {
      toast("Couldn’t start Google sign-in", error.message || "Please try again.", "error");
    } finally {
      connect.disabled = !google.hasClient;
    }
  });
  add(actions, save, connect);
  if (google.connected) {
    const disconnect = button(node, "ghost", "Disconnect");
    disconnect.addEventListener("click", async () => {
      disconnect.disabled = true;
      try {
        await api("/api/metrics/google/disconnect", { method: "POST", body: "{}" });
        stopConnectPolling();
        await refresh();
        toast("Google Health disconnected", "Imported metrics stay in your local archive.");
      } catch (error) {
        toast("Couldn’t disconnect", error.message || "Please try again.", "error");
        disconnect.disabled = false;
      }
    });
    actions.append(disconnect);
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    save.disabled = true;
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify({ googleClientId: clientId.value.trim(), googleClientSecret: clientSecret.value }) });
      clientId.value = ""; clientSecret.value = "";
      await refresh();
      toast("Google client saved", "Now connect your account to start syncing.");
    } catch (error) {
      toast("Couldn’t save the Google client", error.message || "Please try again.", "error");
    } finally {
      save.disabled = false;
    }
  });
  add(form, idField, secretField, actions);
  panel.append(form);
  return panel;
}

export function renderSettings(ctx) {
  const { state, node, add, api, refresh, toast } = ctx;
  const settings = state.settings || {};
  const view = node("section", "view section-page settings-view");
  const header = node("header", "view-header");
  const heading = node("div", "view-heading");
  add(heading,
    node("p", "eyebrow", "Local preferences"),
    node("h1", "", "Settings"),
    node("p", "", "Connect Hevy to import your history and create or edit routines."),
  );
  header.append(heading);
  view.append(header);

  const layout = node("div", "settings-layout");
  const formPanel = node("form", "panel settings-form");
  formPanel.noValidate = true;
  const keyField = node("div", "field");
  const keyLabel = node("label", "", "Hevy API key");
  const apiKey = node("input", "input");
  apiKey.id = "hevy-api-key";
  apiKey.name = "apiKey";
  apiKey.type = "password";
  apiKey.autocomplete = "off";
  apiKey.spellcheck = false;
  apiKey.placeholder = settings.hasApiKey ? "Key saved locally — leave blank to keep it" : "Paste your Hevy API key";
  keyLabel.htmlFor = apiKey.id;
  const keyHint = node("p", "field-hint");
  add(keyHint,
    document.createTextNode("Hevy API access requires "),
    (() => {
      const link = node("a", "", "Hevy Pro");
      link.href = "https://hevy.com/settings?developer";
      link.target = "_blank";
      link.rel = "noreferrer";
      return link;
    })(),
    document.createTextNode(". Sync downloads your data. Creating or saving a routine in Programs writes those changes to Hevy."),
  );
  add(keyField, keyLabel, apiKey, keyHint);

  const unitField = node("div", "field");
  add(unitField, node("span", "", "Display unit"));
  const segmented = node("div", "segmented");
  for (const [value, label] of [["kg", "Kilograms (kg)"], ["lb", "Pounds (lb)"]]) {
    const choice = node("label", "radio-card");
    const input = node("input");
    input.type = "radio";
    input.name = "unit";
    input.value = value;
    input.checked = (settings.unit || "kg") === value;
    add(choice, input, node("span", "", label));
    segmented.append(choice);
  }
  unitField.append(segmented);

  const save = button(node, "primary", "Save settings");
  save.type = "submit";
  formPanel.addEventListener("submit", async (event) => {
    event.preventDefault();
    const selected = formPanel.querySelector('input[name="unit"]:checked');
    save.disabled = true;
    try {
      await api("/api/settings", { method: "POST", body: JSON.stringify({ apiKey: apiKey.value, unit: selected?.value || "kg" }) });
      apiKey.value = "";
      await refresh();
      toast("Settings saved", "Your preferences stay in this local Corpus archive.");
    } catch (error) {
      toast("Couldn’t save settings", error.message || "Please try again.", "error");
    } finally {
      save.disabled = false;
    }
  });
  add(formPanel, keyField, unitField, save);

  const aside = node("aside", "settings-aside");
  add(aside,
    node("p", "eyebrow", "Connection"),
    node("h2", "", settings.hasApiKey ? "Hevy is ready." : "Connect when ready."),
    node("p", "", settings.hasApiKey ? "A key is saved locally. It is never shown here." : "Add a Hevy key to import your training history."),
  );
  const status = node("div", "status-list");
  const statusRows = [
    ["API key", settings.hasApiKey ? "Saved locally" : "Not connected"],
    ["Source", "Hevy"],
    ["Last sync", timestamp(settings.lastSync)],
    ["Current data", state.mode === "demo" ? "Demo" : "Live"],
    ["Google client", settings.googleHealth?.hasClient ? "Saved locally" : "Not saved"],
    ["Google Health", settings.googleHealth?.connected ? "Connected" : "Not connected"],
    ["Metrics last sync", timestamp(settings.googleHealth?.lastSync)],
  ];
  for (const [label, value] of statusRows) add(status, add(node("div", ""), node("span", "", label), node("strong", "", value)));
  aside.append(status);
  add(layout, formPanel, aside);
  view.append(layout);
  view.append(googleHealthPanel(ctx));

  const dataPanel = node("section", "panel");
  const dataHeader = node("header", "panel-header");
  const dataCopy = node("div", "");
  add(dataCopy, node("h2", "", "Data controls"), node("p", "", "Demo and live data stay separate. Your training archive, settings, and key remain on this device."));
  const enableDemo = state.mode !== "demo";
  const toggle = button(node, "secondary", enableDemo ? "Use demo data" : "Use live data");
  toggle.addEventListener("click", async () => {
    toggle.disabled = true;
    try {
      await api("/api/demo", { method: "POST", body: JSON.stringify({ enabled: enableDemo }) });
      await refresh();
      toast(enableDemo ? "Demo data enabled" : "Live data selected", enableDemo ? "Your imported workouts remain safely local." : "Sync when you’re ready to refresh your archive.");
    } catch (error) {
      toast("Couldn’t change data mode", error.message || "Please try again.", "error");
    } finally {
      toggle.disabled = false;
    }
  });
  add(dataHeader, dataCopy, toggle);
  dataPanel.append(dataHeader);
  view.append(dataPanel);
  return view;
}
