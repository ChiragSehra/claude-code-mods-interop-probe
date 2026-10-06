// The lint rules lint-guard ships and enforces. Deliberately ordinary.
export default [
  {
    files: ["src/**/*.js"],
    languageOptions: { ecmaVersion: 2023, sourceType: "commonjs" },
    rules: {
      "no-var": "error",
      "no-unused-vars": "warn",
      eqeqeq: "warn",
    },
  },
]
