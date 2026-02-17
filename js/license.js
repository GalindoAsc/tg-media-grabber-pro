/**
 * License Manager for TG Media Grabber Pro
 */
const LicenseManager = {
  async validateKey(key) {
    return { valid: false, error: "License validation not configured" };
  },

  async saveLicense(data) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ licenseData: data }, resolve);
    });
  },

  async getLicense() {
    return new Promise((resolve) => {
      chrome.storage.local.get(["licenseData"], (result) => {
        resolve(result.licenseData || null);
      });
    });
  },

  async isPro() {
    const data = await this.getLicense();
    return data && data.valid === true;
  }
};
