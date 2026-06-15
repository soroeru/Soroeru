// HTML generation helpers for the PoC test sites. Dummy content only.

import type { ProfileKey, Transform } from "../src/types.js";

export interface FieldSpec {
  name: string;
  /** Human label; how it is shown depends on the site layout. */
  label: string;
  control: "text" | "select" | "radio" | "checkbox";
  /** input type for control=text (text / email / tel / password). */
  type?: string;
  id?: string;
  autocomplete?: string;
  required?: boolean;
  /** Extra placeholder (placeholder layout always uses label as placeholder). */
  placeholder?: string;
  options?: string[];
  /** Ground truth: which profile key SHOULD be filled here. undefined = must stay unmapped. */
  gt?: { profileKey: ProfileKey; transform?: Transform };
  /** Include on the edit page (default: true except password/checkbox). */
  inEdit?: boolean;
}

export type FormLayout = "label-for" | "table" | "placeholder-only";

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function page(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<style>
body { font-family: sans-serif; margin: 2rem auto; max-width: 760px; color: #222; }
nav a { margin-right: 1rem; }
.row { margin: .7rem 0; }
.row label { display: inline-block; min-width: 12rem; vertical-align: top; }
table.form { border-collapse: collapse; }
table.form th, table.form td { border: 1px solid #bbb; padding: .5rem .8rem; text-align: left; }
section.terms { border: 1px solid #ccc; padding: 1rem; max-height: 14rem; overflow-y: scroll; background: #fafafa; }
button { padding: .5rem 1.4rem; }
.notice { color: #555; font-size: .9rem; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

export function nav(base: string, links: { href: string; label: string }[]): string {
  return `<nav>${links.map((l) => `<a href="${esc(l.href.startsWith("http") ? l.href : base + l.href)}">${esc(l.label)}</a>`).join("")}</nav>`;
}

function inputAttrs(f: FieldSpec, value: string | undefined, withId: boolean): string {
  const attrs: string[] = [`name="${esc(f.name)}"`];
  if (withId && f.id) attrs.push(`id="${esc(f.id)}"`);
  if (f.autocomplete) attrs.push(`autocomplete="${esc(f.autocomplete)}"`);
  if (f.required) attrs.push("required");
  if (f.placeholder) attrs.push(`placeholder="${esc(f.placeholder)}"`);
  if (value !== undefined) attrs.push(`value="${esc(value)}"`);
  return attrs.join(" ");
}

function controlHtml(f: FieldSpec, layout: FormLayout, values?: Record<string, string>): string {
  const value = values?.[f.name];
  const withId = layout !== "table"; // the cryptic table site has no ids tying labels to inputs
  switch (f.control) {
    case "text": {
      const attrs = inputAttrs(
        layout === "placeholder-only" ? { ...f, placeholder: f.placeholder ?? f.label } : f,
        value,
        withId,
      );
      return `<input type="${esc(f.type ?? "text")}" ${attrs}>`;
    }
    case "select": {
      const opts = (f.options ?? [])
        .map((o) => `<option value="${esc(o)}"${o === value ? " selected" : ""}>${esc(o)}</option>`)
        .join("");
      return `<select name="${esc(f.name)}"${withId && f.id ? ` id="${esc(f.id)}"` : ""}${f.required ? " required" : ""}><option value="">選択してください</option>${opts}</select>`;
    }
    case "radio":
      return (f.options ?? [])
        .map(
          (o) =>
            `<label><input type="radio" name="${esc(f.name)}" value="${esc(o)}"${o === value ? " checked" : ""}> ${esc(o)}</label>`,
        )
        .join(" ");
    case "checkbox":
      return `<label><input type="checkbox" name="${esc(f.name)}" value="on"${value === "on" ? " checked" : ""}${f.required ? " required" : ""}> ${esc(f.label)}</label>`;
  }
}

/** Render a form body in the given layout. `values` makes it a prefilled edit form. */
export function renderFields(specs: FieldSpec[], layout: FormLayout, values?: Record<string, string>): string {
  if (layout === "table") {
    const rows = specs
      .map((f) =>
        f.control === "checkbox"
          ? `<tr><th></th><td>${controlHtml(f, layout, values)}</td></tr>`
          : `<tr><th>${esc(f.label)}${f.required ? "（必須）" : ""}</th><td>${controlHtml(f, layout, values)}</td></tr>`,
      )
      .join("\n");
    return `<table class="form">\n${rows}\n</table>`;
  }
  return specs
    .map((f) => {
      if (f.control === "checkbox") return `<div class="row">${controlHtml(f, layout, values)}</div>`;
      if (layout === "placeholder-only") return `<div class="row">${controlHtml(f, layout, values)}</div>`;
      const forAttr = f.id ? ` for="${esc(f.id)}"` : "";
      return `<div class="row"><label${forAttr}>${esc(f.label)}${f.required ? "（必須）" : ""}</label>${controlHtml(f, layout, values)}</div>`;
    })
    .join("\n");
}

export function formPage(opts: {
  title: string;
  base: string;
  navLinks: { href: string; label: string }[];
  heading: string;
  action: string;
  layout: FormLayout;
  specs: FieldSpec[];
  submitLabel: string;
  beforeForm?: string;
  values?: Record<string, string>;
}): string {
  return page(
    opts.title,
    `${nav(opts.base, opts.navLinks)}
<h1>${esc(opts.heading)}</h1>
${opts.beforeForm ?? ""}
<form method="post" action="${esc(opts.action)}">
${renderFields(opts.specs, opts.layout, opts.values)}
<div class="row"><button type="submit">${esc(opts.submitLabel)}</button></div>
</form>`,
  );
}
