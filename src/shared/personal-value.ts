export const RAW_VALUE_PATTERNS: { name: string; re: RegExp }[] = [
  { name: "email address", re: /[\w.+-]+@[\w-]+\.[\w.-]+/ },
  { name: "card-number-like digit sequence", re: /\d[\d -]{10,18}\d/ },
  { name: "phone-number-like value", re: /0\d{1,4}-\d{1,4}-\d{3,4}/ },
];

/** #80 defense-in-depth heuristic; closed schema types remain the primary boundary. */
export function looksLikePersonalValue(text: string): boolean {
  return RAW_VALUE_PATTERNS.some(({ re }) => re.test(text));
}
