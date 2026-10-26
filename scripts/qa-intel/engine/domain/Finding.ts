export interface Finding {
  file: string;
  severity: "low" | "medium" | "high" | "critical";
  title: string;
  why: string;
  fix: string;
}
