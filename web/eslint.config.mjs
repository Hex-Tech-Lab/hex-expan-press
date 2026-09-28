import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

// eslint-config-next 16.3.3 ships native flat configs (peer eslint >= 9).
const eslintConfig = [
  {
    ignores: [".next/**", "node_modules/**", "public/**", "out/**"],
  },
  ...coreWebVitals,
  ...typescript,
];

export default eslintConfig;
