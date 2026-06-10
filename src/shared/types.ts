export const BASIC_PROFILE_FIELD_KINDS = [
  "fullName",
  "email",
  "phone",
  "postalCode",
  "address",
  "companyName",
  "departmentName",
] as const;

export type BasicProfileFieldKind = (typeof BASIC_PROFILE_FIELD_KINDS)[number];

export type ProfileFieldKind = BasicProfileFieldKind | "custom";

export type ProfileFieldBase = {
  id: string;
  label: string;
  value: string;
  order: number;
};

export type BasicProfileField = ProfileFieldBase & {
  kind: BasicProfileFieldKind;
};

export type CustomProfileField = ProfileFieldBase & {
  kind: "custom";
  matchTerms: string[];
};

export type ProfileField = BasicProfileField | CustomProfileField;

export type ProfileFieldInput =
  | (Omit<BasicProfileField, "id"> & { id?: string })
  | (Omit<CustomProfileField, "id"> & { id?: string });

export const PROFILE_FIELD_LABELS: Record<BasicProfileFieldKind, string> = {
  fullName: "Full name",
  email: "Email address",
  phone: "Phone number",
  postalCode: "Postal code",
  address: "Address",
  companyName: "Company name",
  departmentName: "Department name",
};

export interface ScannedFieldBase {
  fieldId: string;
  value: string;
  visible: boolean;
  labelCandidates: string[];
}

export type ScannedField =
  | (ScannedFieldBase & { tag: "input"; type: string })
  | (ScannedFieldBase & { tag: "textarea" })
  | (ScannedFieldBase & { tag: "select" });
