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
  ];
  for (const [label, value] of statusRows) add(status, add(node("div", ""), node("span", "", label), node("strong", "", value)));
  aside.append(status);
  add(layout, formPanel, aside);
  view.append(layout);

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
