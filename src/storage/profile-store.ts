import { parseProfileField } from "../shared/profile-validation.js";
import type { ProfileField } from "../shared/types.js";
import "../shared/chrome.js";

export interface ProfileStorage {
  get(id: string): Promise<ProfileField | undefined>;
  set(field: ProfileField): Promise<ProfileField>;
  list(): Promise<ProfileField[]>;
  delete(id: string): Promise<void>;
  clear(): Promise<void>;
}

const PROFILE_FIELDS_KEY = "profileFields";

export class InMemoryProfileStorage implements ProfileStorage {
  private fields = new Map<string, ProfileField>();

  async get(id: string): Promise<ProfileField | undefined> {
    const field = this.fields.get(id);
    return field ? cloneProfileField(field) : undefined;
  }

  async set(field: ProfileField): Promise<ProfileField> {
    const parsedField = parseProfileField(field);
    this.fields.set(parsedField.id, cloneProfileField(parsedField));
    return cloneProfileField(parsedField);
  }

  async list(): Promise<ProfileField[]> {
    return sortFields([...this.fields.values()].map(cloneProfileField));
  }

  async delete(id: string): Promise<void> {
    this.fields.delete(id);
  }

  async clear(): Promise<void> {
    this.fields.clear();
  }
}

export class ChromeProfileStorage implements ProfileStorage {
  constructor(private readonly storageArea: ChromeStorageArea = chrome.storage.local) {}

  async get(id: string): Promise<ProfileField | undefined> {
    return (await this.list()).find((field) => field.id === id);
  }

  async set(field: ProfileField): Promise<ProfileField> {
    const parsedField = parseProfileField(field);
    const fields = await this.list();
    const nextFields = fields.filter((storedField) => storedField.id !== parsedField.id);
    nextFields.push(parsedField);
    await this.writeFields(nextFields);
    return cloneProfileField(parsedField);
  }

  async list(): Promise<ProfileField[]> {
    const items = await this.getItems(PROFILE_FIELDS_KEY);
    const storedFields = items[PROFILE_FIELDS_KEY];
    if (!Array.isArray(storedFields)) {
      return [];
    }

    return sortFields(storedFields.map(parseProfileField).map(cloneProfileField));
  }

  async delete(id: string): Promise<void> {
    const fields = (await this.list()).filter((field) => field.id !== id);
    await this.writeFields(fields);
  }

  async clear(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.storageArea.remove(PROFILE_FIELDS_KEY, resolve);
    });
  }

  private async writeFields(fields: ProfileField[]): Promise<void> {
    const validatedFields = sortFields(fields.map(parseProfileField).map(cloneProfileField));
    await new Promise<void>((resolve) => {
      this.storageArea.set({ [PROFILE_FIELDS_KEY]: validatedFields }, resolve);
    });
  }

  private async getItems(key: string): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      this.storageArea.get(key, resolve);
    });
  }
}

function sortFields(fields: ProfileField[]): ProfileField[] {
  return fields.sort((left, right) => left.order - right.order || left.label.localeCompare(right.label));
}

function cloneProfileField(field: ProfileField): ProfileField {
  return structuredClone(field);
}
