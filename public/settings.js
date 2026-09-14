import { MODE_COPY } from "./app.js";
import { invalidateMetrics } from "./metrics.js";
import { invalidateWorkoutMetrics } from "./metrics-workouts.js";
import { invalidateSupplementDoses } from "./supplements.js";

/** One string for every stored secret, on every card (SET-7). */
const SAVED_PLACEHOLDER = "Saved locally — leave blank to keep it";

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
        toast("Google Health connected", "Sync now to import your metrics.");
      }
    } catch { /* keep polling until the limit */ }
    finally { checking = false; }
  }, CONNECT_POLL_MS);
}

function externalLink(ctx, href, text) {
  const link = ctx.node("a", "", text);
  link.href = href;
  link.target = "_blank";
  link.rel = "noreferrer";
  return link;
}

/** A panel-level hint: plain sentences with one inline link. */
function setupHint(ctx, parts) {
  const hint = ctx.node("p", "field-hint");
  for (const part of parts) hint.append(typeof part === "string" ? document.createTextNode(part) : part);
  return hint;
}

/**
 * The one integration card (D4). Every data source renders the same shape:
 * header + status pill → credential fields → panel hint → action row → last sync.
 */
function integrationCard(ctx, { name, description, status, fields, hint, actions, lastSync, onSave }) {
  const { node, add, panelHeader, format } = ctx;
  const card = node("section", "panel integration-card");
  add(card, panelHeader(name, description, status));
  const form = node("form", "panel-stack");
  form.noValidate = true;
  form.addEventListener("submit", onSave);
  add(form, fields, hint, add(node("div", "card-actions"), actions));
  add(card, form, node("p", "note", lastSync ? `Last synced ${format.formatDateTime(lastSync)}` : format.NEVER_SYNCED));
  return card;
}

function statusPill(ctx, connected, label) {
  return ctx.node("span", `pill pill--${connected ? "positive" : "neutral"}`, label);
}

/** Confirms an action that breaks a connection; local data always survives it. */
function confirmDisconnect(ctx, { eyebrow, title, copy, onConfirm }) {
  const { node, add, button, openDialog, closeDialog } = ctx;
  const content = add(node("div", "dialog-stack"), node("p", "", copy));
  const confirm = button("Disconnect", {
    variant: "danger",
    onClick: async () => {
      closeDialog();
      await onConfirm();
    },
  });
  add(content, add(node("div", "dialog-actions"), button("Cancel", { onClick: () => closeDialog() }), confirm));
  openDialog(eyebrow, title, content);
}

/* -------------------------------------------------------------------- Hevy */

function hevyCard(ctx) {
  const { state, node, api, refresh, toast, field, button, setBusy, format } = ctx;
  const settings = state.settings || {};
  const saved = Boolean(settings.hasApiKey);

  const key = field("Hevy API key", {
    type: "password",
    name: "apiKey",
    autocomplete: "off",
    placeholder: saved ? SAVED_PLACEHOLDER : "Paste your Hevy API key",
  });
  key.control.spellcheck = false;

  const save = button("Save key", { variant: "primary", size: "sm", type: "submit" });
  const actions = [save];

  if (saved) {
    const sync = button("Sync now", {
      size: "sm",
      icon: "↻",
      onClick: async () => {
        setBusy(sync, true);
        try {
          const result = await api("/api/sync", { method: "POST", body: "{}" });
          // New sessions change workout metrics coverage and the derived workout doses.
          invalidateWorkoutMetrics();
          invalidateSupplementDoses();
          await refresh();
          const count = Array.isArray(result?.workouts) ? result.workouts.length : 0;
          const extra = result?.mode === "demo" ? " Switch to live data to see the changes." : "";
          toast("Hevy synced", `${format.plural(count, "workout")} in your local archive.${extra}`);
        } catch (error) {
          toast("Couldn’t sync Hevy", error.message || "Please try again.", "error");
          setBusy(sync, false);
        }
      },
    });

    const disconnect = button("Disconnect", {
      variant: "danger",
      size: "sm",
      onClick: () => confirmDisconnect(ctx, {
        eyebrow: "Hevy",
        title: "Disconnect Hevy?",
        copy: "Your imported workouts stay on this device. Corpus forgets the API key, so syncing and writing routines back to Hevy stop until you save a key again.",
        onConfirm: async () => {
          setBusy(disconnect, true);
          try {
            await api("/api/settings", { method: "POST", body: JSON.stringify({ clearApiKey: true }) });
            await refresh();
            toast("Hevy disconnected", "Your imported workouts stay on this device.");
          } catch (error) {
            toast("Couldn’t disconnect Hevy", error.message || "Please try again.", "error");
            setBusy(disconnect, false);
          }
        },
      }),
    });
    actions.push(sync, disconnect);
  }

  return integrationCard(ctx, {
    name: "Hevy",
    description: "Workouts, routines, and exercise templates.",
    status: statusPill(ctx, saved, saved ? "Connected" : "Not connected"),
    fields: [key],
    hint: setupHint(ctx, [
      "Hevy API access requires ",
      externalLink(ctx, "https://hevy.com/settings?developer", "Hevy Pro"),
      ". Sync downloads your data. Creating or saving a routine in Programs writes those changes to Hevy.",
    ]),
    actions,
    lastSync: settings.lastSync,
    onSave: async (event) => {
      event.preventDefault();
      const value = key.control.value.trim();
      if (!value) {
        if (saved) toast("Hevy key kept", "The key saved on this device is unchanged. Paste a new key to replace it.");
        else toast("Couldn’t save the Hevy key", "Paste your Hevy API key first.", "error");
        return;
      }
      setBusy(save, true);
      try {
        await api("/api/settings", { method: "POST", body: JSON.stringify({ apiKey: value }) });
        key.control.value = "";
        await refresh();
        toast("Hevy key saved", "Sync now to import your history.");
      } catch (error) {
        toast("Couldn’t save the Hevy key", error.message || "Please try again.", "error");
        setBusy(save, false);
      }
    },
  });
}

/* ----------------------------------------------------------- Google Health */

function googleCard(ctx) {
  const { state, api, refresh, toast, field, button, setBusy, format } = ctx;
  const google = state.settings?.googleHealth || { hasClient: false, connected: false, lastSync: null };
  const { hasClient, connected } = google;

  const clientId = field("Google OAuth client ID", {
    name: "googleClientId",
    autocomplete: "off",
    placeholder: hasClient ? SAVED_PLACEHOLDER : "1234567890-abc.apps.googleusercontent.com",
  });
  clientId.control.spellcheck = false;
  const clientSecret = field("Google OAuth client secret", {
    type: "password",
    name: "googleClientSecret",
    autocomplete: "off",
    placeholder: hasClient ? SAVED_PLACEHOLDER : "Paste the client secret",
  });
  clientSecret.control.spellcheck = false;

  const save = button("Save client", { variant: "primary", size: "sm", type: "submit" });
  const actions = [save];

  if (hasClient && !connected) {
    const connect = button("Connect", {
      size: "sm",
      onClick: async () => {
        setBusy(connect, true);
        try {
          const result = await api("/api/metrics/google/connect", { method: "POST", body: "{}" });
          if (!result?.url) throw new Error("The server did not return a sign-in link.");
          window.open(result.url, "_blank", "noopener");
          toast("Google sign-in opened", "Approve access in the new tab; Corpus notices once it is granted.");
          pollForConnection(ctx);
        } catch (error) {
          toast("Couldn’t connect Google Health", error.message || "Please try again.", "error");
        } finally {
          setBusy(connect, false);
        }
      },
    });
    actions.push(connect);
  }

  if (connected) {
    const sync = button("Sync now", {
      size: "sm",
      icon: "↻",
      onClick: async () => {
        setBusy(sync, true);
        try {
          const result = await api("/api/metrics/sync", { method: "POST", body: "{}" });
          invalidateMetrics();
          invalidateWorkoutMetrics();
          await refresh();
          const imported = Number(result?.imported) || 0;
          const warnings = (Array.isArray(result?.warnings) ? result.warnings : []).filter(Boolean);
          toast("Google Health synced", [`${format.plural(imported, "data point")} imported.`, ...warnings].join(" "));
        } catch (error) {
          toast("Couldn’t sync Google Health", error.message || "Please try again.", "error");
          setBusy(sync, false);
        }
      },
    });

    const disconnect = button("Disconnect", {
      variant: "danger",
      size: "sm",
      onClick: () => confirmDisconnect(ctx, {
        eyebrow: "Google Health",
        title: "Disconnect Google Health?",
        copy: "Your imported metrics stay on this device. Corpus revokes and forgets the Google tokens, so you sign in again to resume syncing.",
        onConfirm: async () => {
          setBusy(disconnect, true);
          try {
            await api("/api/metrics/google/disconnect", { method: "POST", body: "{}" });
            stopConnectPolling();
            await refresh();
            toast("Google Health disconnected", "Your imported metrics stay on this device.");
          } catch (error) {
            toast("Couldn’t disconnect Google Health", error.message || "Please try again.", "error");
            setBusy(disconnect, false);
          }
        },
      }),
    });
    actions.push(sync, disconnect);
  }

  return integrationCard(ctx, {
    name: "Google Health",
    description: "Daily activity, heart, sleep, and body metrics.",
    status: statusPill(ctx, connected, connected ? "Connected" : hasClient ? "Client saved" : "Not connected"),
    fields: [clientId, clientSecret],
    hint: setupHint(ctx, [
      "Create a Desktop app OAuth client in ",
      externalLink(ctx, "https://console.cloud.google.com/apis/credentials", "Google Cloud credentials"),
      ", enable the Google Health API, and add yourself as a test user. Credentials and tokens stay in your local data folder.",
    ]),
    actions,
    lastSync: google.lastSync,
    onSave: async (event) => {
      event.preventDefault();
      const id = clientId.control.value.trim();
      const secret = clientSecret.control.value;
      if (!id && !secret.trim()) {
        if (hasClient) toast("Google client kept", "The credentials saved on this device are unchanged. Paste new ones to replace them.");
        else toast("Couldn’t save the Google client", "Paste a client ID and secret first.", "error");
        return;
      }
      setBusy(save, true);
      try {
        await api("/api/settings", { method: "POST", body: JSON.stringify({ googleClientId: id, googleClientSecret: secret }) });
        clientId.control.value = "";
        clientSecret.control.value = "";
        await refresh();
        toast("Google client saved", "Connect your account to start syncing.");
      } catch (error) {
        toast("Couldn’t save the Google client", error.message || "Please try again.", "error");
        setBusy(save, false);
      }
    },
  });
}

/* ------------------------------------------------------ data & preferences */

function dataModeField(ctx) {
  const { state, node, add, button } = ctx;
  const mode = state.mode === "demo" ? "demo" : "live";
  const group = node("fieldset", "field");
  add(group, node("legend", "field-label", "Data mode"));
  const toggle = button(MODE_COPY.toggle[mode], { onClick: () => ctx.setMode(state.mode !== "demo", toggle) });
  add(group, add(node("div", "status-row"), node("span", "pill pill--neutral", MODE_COPY.badge[mode]), toggle));
  return group;
}

function displayUnitField(ctx) {
  const { state, node, add, api, refresh, toast } = ctx;
  const current = state.settings?.unit === "lb" ? "lb" : "kg";
  const group = node("fieldset", "field");
  add(group, node("legend", "field-label", "Display unit"));
  const segmented = node("div", "segmented");
  for (const [value, label, sentence] of [
    ["kg", "Kilograms (kg)", "Loads now show in kilograms (kg)."],
    ["lb", "Pounds (lb)", "Loads now show in pounds (lb)."],
  ]) {
    const choice = node("label", "radio-card");
    const input = node("input");
    input.type = "radio";
    input.name = "unit";
    input.value = value;
    input.checked = current === value;
    // A preference applies on change; it is never gated behind a submit (D5).
    input.addEventListener("change", async () => {
      if (!input.checked || value === current) return;
      try {
        await api("/api/settings", { method: "POST", body: JSON.stringify({ unit: value }) });
        await refresh();
        toast("Display unit saved", sentence);
      } catch (error) {
        toast("Couldn’t save the display unit", error.message || "Please try again.", "error");
        await refresh().catch(() => {});
      }
    });
    add(choice, input, node("span", "", label));
    segmented.append(choice);
  }
  add(group, segmented);
  return group;
}

function exportRow(ctx) {
  const { node, add, api, toast, button, setBusy, format } = ctx;
  const control = button("Export Markdown", {
    icon: "↓",
    onClick: async () => {
      setBusy(control, true);
      try {
        const result = await api("/api/export", { method: "POST", body: "{}" });
        const files = Array.isArray(result?.files) ? result.files : [];
        toast("Markdown exported", `${format.plural(files.length, "file")} written to data/exports/.`);
      } catch (error) {
        toast("Couldn’t export Markdown", error.message || "Please try again.", "error");
      } finally {
        setBusy(control, false);
      }
    },
  });
  return add(node("div", "status-row"), node("p", "note", "Write your archive as Markdown files to data/exports/."), control);
}

function preferencesPanel(ctx) {
  const { node, add, panelHeader } = ctx;
  const panel = node("section", "panel");
  add(panel,
    panelHeader("Data & preferences", "Demo and live archives stay separate. Everything stays on this device."),
    dataModeField(ctx),
    displayUnitField(ctx),
    exportRow(ctx),
  );
  return panel;
}

/* ------------------------------------------------------------------- view */

export function renderSettings(ctx) {
  const { node, add, heading } = ctx;
  const view = node("section", "view section-page settings-view");
  add(view,
    heading("Settings", "Settings", "Connect your data sources, choose how numbers are shown, and switch between demo and live data."),
    hevyCard(ctx),
    googleCard(ctx),
    preferencesPanel(ctx),
  );
  return view;
}
