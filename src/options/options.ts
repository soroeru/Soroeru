import { isBasicProfileFieldKind, ProfileFieldValidationError } from "../shared/profile-validation.js";
import { PROFILE_FIELD_LABELS, type BasicProfileFieldKind, type ProfileField } from "../shared/types.js";
import { ChromeProfileStorage } from "../storage/profile-store.js";

const storage = new ChromeProfileStorage();

const form = getElement<HTMLFormElement>("profile-field-form");
const idInput = getElement<HTMLInputElement>("field-id");
const kindInput = getElement<HTMLSelectElement>("field-kind");
const labelInput = getElement<HTMLInputElement>("field-label");
const valueInput = getElement<HTMLTextAreaElement>("field-value");
const matchTermsInput = getElement<HTMLInputElement>("field-match-terms");
const orderInput = getElement<HTMLInputElement>("field-order");
const listRoot = getElement<HTMLDivElement>("field-list");
const statusMessage = getElement<HTMLParagraphElement>("status-message");
let busyCount = 0;
let lastAutoLabel: string | undefined;

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  await runUiOperation(async () => {
    const field = buildFieldFromForm();
    await storage.set(field);
    resetForm();
    await renderFields();
    setStatus("Saved locally.");
  });
});

getElement<HTMLButtonElement>("reset-form").addEventListener("click", () => {
  resetForm();
  setStatus("");
});

getElement<HTMLButtonElement>("clear-fields").addEventListener("click", async () => {
  await runUiOperation(async () => {
    await storage.clear();
    await renderFields();
    resetForm();
    setStatus("All profile fields were cleared.");
  });
});

getElement<HTMLButtonElement>("add-fake-data").addEventListener("click", async () => {
  await runUiOperation(async () => {
    await addFakeData();
    await renderFields();
    resetForm();
    setStatus("Fake profile data was added.");
  });
});

labelInput.addEventListener("input", () => {
  lastAutoLabel = undefined;
});

kindInput.addEventListener("change", () => {
  if (kindInput.value === "custom") {
    return;
  }

  if (!labelInput.value.trim() || labelInput.value === lastAutoLabel) {
    setAutoLabel(PROFILE_FIELD_LABELS[kindInput.value as BasicProfileFieldKind]);
  }
});

resetForm();
await runUiOperation(async () => {
  await renderFields();
});

async function renderFields(): Promise<void> {
  const fields = await storage.list();
  listRoot.replaceChildren();

  if (fields.length === 0) {
    const emptyMessage = document.createElement("p");
    emptyMessage.textContent = "No profile fields are stored yet.";
    listRoot.append(emptyMessage);
    return;
  }

  for (const field of fields) {
    listRoot.append(renderFieldCard(field));
  }

  if (busyCount > 0) {
    setControlsDisabled(true);
  }
}

function renderFieldCard(field: ProfileField): HTMLElement {
  const card = document.createElement("article");
  card.className = "ffa-field-card";

  const heading = document.createElement("h3");
  heading.textContent = field.label;

  const meta = document.createElement("p");
  meta.className = "ffa-meta";
  meta.textContent = `${field.kind} · order ${field.order}`;

  const value = document.createElement("p");
  value.className = "ffa-value";
  value.textContent = field.value;

  const actions = document.createElement("div");
  actions.className = "ffa-card-actions";

  const editButton = document.createElement("button");
  editButton.type = "button";
  editButton.textContent = "Edit";
  editButton.addEventListener("click", () => loadFieldIntoForm(field));

  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.textContent = "Delete";
  deleteButton.addEventListener("click", async () => {
    await runUiOperation(async () => {
      await storage.delete(field.id);
      await renderFields();
      setStatus("Deleted locally.");
    });
  });

  actions.append(editButton, deleteButton);
  card.append(heading, meta, value, actions);

  if (field.kind === "custom") {
    const matchTerms = document.createElement("p");
    matchTerms.className = "ffa-meta";
    matchTerms.textContent = `Match terms: ${field.matchTerms.join(", ")}`;
    card.insertBefore(matchTerms, actions);
  }

  return card;
}

function buildFieldFromForm(): ProfileField {
  const id = idInput.value || createId();
  const kind = kindInput.value;
  const label = labelInput.value.trim();
  const value = valueInput.value;
  const order = Number(orderInput.value);

  if (kind === "custom") {
    return {
      id,
      kind,
      label,
      value,
      order,
      matchTerms: matchTermsInput.value
        .split(",")
        .map((term) => term.trim())
        .filter(Boolean),
    };
  }

  if (isBasicProfileFieldKind(kind)) {
    return {
      id,
      kind,
      label,
      value,
      order,
    };
  }

  throw new ProfileFieldValidationError("Profile field kind is not supported.");
}

function loadFieldIntoForm(field: ProfileField): void {
  idInput.value = field.id;
  kindInput.value = field.kind;
  labelInput.value = field.label;
  valueInput.value = field.value;
  orderInput.value = String(field.order);
  matchTermsInput.value = field.kind === "custom" ? field.matchTerms.join(", ") : "";
  lastAutoLabel =
    field.kind !== "custom" && field.label === PROFILE_FIELD_LABELS[field.kind] ? field.label : undefined;
  setStatus("Editing existing field.");
}

function resetForm(): void {
  form.reset();
  idInput.value = "";
  orderInput.value = "0";
  setAutoLabel(PROFILE_FIELD_LABELS.fullName);
}

async function addFakeData(): Promise<void> {
  const fakeFields: ProfileField[] = [
    {
      id: "fake-full-name",
      kind: "fullName",
      label: PROFILE_FIELD_LABELS.fullName,
      value: "Taro Yamada",
      order: 10,
    },
    {
      id: "fake-email",
      kind: "email",
      label: PROFILE_FIELD_LABELS.email,
      value: "taro.yamada@example.test",
      order: 20,
    },
    {
      id: "fake-company",
      kind: "companyName",
      label: PROFILE_FIELD_LABELS.companyName,
      value: "Example Works Ltd.",
      order: 30,
    },
    {
      id: "fake-department",
      kind: "departmentName",
      label: PROFILE_FIELD_LABELS.departmentName,
      value: "Operations",
      order: 40,
    },
    {
      id: "fake-custom-industry",
      kind: "custom",
      label: "Industry",
      value: "Software",
      matchTerms: ["industry", "業種"],
      order: 50,
    },
  ];

  for (const field of fakeFields) {
    await storage.set(field);
  }
}

function getElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) {
    throw new Error(`Missing options page element: ${id}`);
  }
  return element as T;
}

function setStatus(message: string): void {
  statusMessage.textContent = message;
}

function setAutoLabel(label: string): void {
  labelInput.value = label;
  lastAutoLabel = label;
}

async function runUiOperation(operation: () => Promise<void>): Promise<void> {
  busyCount += 1;
  setControlsDisabled(busyCount > 0);
  try {
    await operation();
  } catch (error) {
    if (error instanceof ProfileFieldValidationError) {
      setStatus(error.message);
      return;
    }

    console.error("Profile options operation failed.", error);
    setStatus("Could not update profile fields.");
  } finally {
    busyCount = Math.max(0, busyCount - 1);
    setControlsDisabled(busyCount > 0);
  }
}

function setControlsDisabled(disabled: boolean): void {
  const controls = document.querySelectorAll<
    HTMLButtonElement | HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement
  >("button, input, select, textarea");
  for (const control of Array.from(controls)) {
    control.disabled = disabled;
  }
}

function createId(): string {
  if (typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `profile-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}
