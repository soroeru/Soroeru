const path = require("node:path");
const packageJson = require("./package.json");

/** @type {import("@electron-forge/shared-types").ForgeConfig} */
module.exports = {
  packagerConfig: {
    name: "Soroeru",
    executableName: "Soroeru",
    appBundleId: "app.soroeru.soroeru",
    appCategoryType: "public.app-category.productivity",
    appVersion: packageJson.version,
    buildVersion: packageJson.version,
    icon: path.join(__dirname, "assets", "soroeru"),
    osxSign: false,
    asar: false,
    extendInfo: {
      CFBundleDisplayName: "Soroeru",
      CFBundleName: "Soroeru",
      LSMinimumSystemVersion: "14.0",
    },
  },
  makers: [
    {
      name: "@electron-forge/maker-dmg",
      config: {
        name: `Soroeru-${packageJson.version}`,
        format: "ULFO",
      },
    },
  ],
};
