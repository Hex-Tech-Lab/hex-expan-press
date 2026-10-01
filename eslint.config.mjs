import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["node_modules/**", "web/**", "data/**"],
  },
  ...tseslint.configs.recommended,
  {
    files: ["src/**/*.ts", "payments/**/*.ts"],
  }
);
