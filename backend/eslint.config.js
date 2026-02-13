export default [
  {
    files: ["**/*.js", "**/*.cjs", "**/*.mjs"],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: "module",
    },
    rules: {
      // Security
      "no-eval": "error",
      "no-implied-eval": "error",
      "no-new-func": "error",

      // Performance
      "no-await-in-loop": "warn",
      "no-inner-declarations": "warn",

      // Style
      "no-console": "warn",
      "no-debugger": "error",
      "no-unused-vars": "warn",
    },
  },
];
