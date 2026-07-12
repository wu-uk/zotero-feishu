// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default [
  {
    name: "zotero-feishu/generated-ignores",
    ignores: [".agents/**", "skills-lock.json"],
  },
  ...zotero(),
];
