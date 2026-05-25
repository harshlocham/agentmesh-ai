import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";
import importPlugin from "eslint-plugin-import";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const webAppDir = join(__dirname, "apps/web");

const compat = new FlatCompat({
  baseDirectory: webAppDir,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),

  {
    plugins: {
      import: importPlugin,
    },

    rules: {
      "import/no-restricted-paths": [
        "error",
        {
          zones: [
            {
              target: "./components",
              from: "./app/api",
              message: "Client components cannot import API route handlers.",
            },
            {
              target: "./app/api",
              from: "./components",
              message: "API routes should not depend on UI components.",
            },
          ],
        },
      ],
    },
  },
];

export default eslintConfig;