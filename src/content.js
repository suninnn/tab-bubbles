// Runs in each page. Looks for signs of an unfinished task and reports ONLY flags
// (kinds of signal, counts) to the extension. No field values, page text or URLs
// beyond what the tabs API already has ever leave this script.
(() => {
  const OTP_RE = /(otp|one[-_ ]?time|verif|2fa|mfa|passcode|security[-_ ]?code|auth[-_ ]?code|sms[-_ ]?code|confirmation[-_ ]?code|验证码)/i;
  const CHECKOUT_RE = /(checkout|cart|payment|billing|apply|application|signup|sign-up|register|onboarding)/i;

  function visible(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  }

  function scan() {
    const signals = [];
    const inputs = [...document.querySelectorAll("input, textarea, select, [contenteditable='true']")].filter(visible);

    // 1) Verification-code box waiting to be filled
    const otp = inputs.filter(el => {
      if (el.tagName !== "INPUT") return false;
      const hint = [el.autocomplete, el.name, el.id, el.placeholder, el.getAttribute("aria-label")].join(" ");
      const shortNumeric = (el.inputMode === "numeric" || el.type === "tel" || el.type === "number") &&
        el.maxLength > 0 && el.maxLength <= 8;
      return (el.autocomplete === "one-time-code" || OTP_RE.test(hint) || (shortNumeric && OTP_RE.test(document.body.innerText.slice(0, 5000))));
    });
    if (otp.length && otp.some(el => !el.value)) signals.push("otp");

    // 2) Half-filled form: some fields have values, some required ones are still empty
    for (const form of document.forms) {
      const fields = [...form.elements].filter(el =>
        /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) &&
        !/^(hidden|submit|button|reset|image|search)$/i.test(el.type) && visible(el));
      if (fields.length < 2) continue;
      const filled = fields.filter(el => (el.type === "checkbox" || el.type === "radio") ? el.checked : !!el.value);
      const emptyRequired = fields.filter(el => el.required && !el.value);
      if (filled.length >= 1 && (emptyRequired.length >= 1 || filled.length < fields.length)) {
        signals.push("half-form");
        break;
      }
    }

    // 3) Unsaved text typed into a long text box / editor
    if (inputs.some(el => (el.tagName === "TEXTAREA" && el.value.length > 20) ||
                          (el.isContentEditable && el.innerText.trim().length > 20 && el.dataset.tbTyped))) {
      signals.push("unsaved-text");
    }

    // 4) Checkout / application / sign-up style page
    if (CHECKOUT_RE.test(location.pathname) || CHECKOUT_RE.test(document.title)) signals.push("flow-page");

    return [...new Set(signals)];
  }

  // Mark editors the user actually typed into (so pre-filled editors don't count)
  document.addEventListener("input", e => {
    const t = e.target;
    if (t && t.isContentEditable) t.dataset.tbTyped = "1";
    schedule();
  }, true);

  let last = "";
  let timer = null;
  function report() {
    const signals = scan();
    const key = signals.join(",");
    if (key === last) return;
    last = key;
    chrome.runtime.sendMessage({ type: "tb-signals", signals }).catch(() => {});
  }
  function schedule() { clearTimeout(timer); timer = setTimeout(report, 1500); }

  report();
  new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("visibilitychange", () => { if (document.hidden) report(); });
})();
