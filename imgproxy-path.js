/** Optional sharpen sigma (replaces legacy `pr:sharp` preset — not defined on stock imgproxy). */
const sharpenSigma = process?.env?.IMGPROXY_SHARPEN_SIGMA?.trim() || "";

export function imgproxyLeadingOptions() {
    return sharpenSigma ? `sh:${sharpenSigma}` : "";
}

export function joinImgproxyPath(base, ...segments) {
    const parts = [base, ...segments].filter(Boolean);
    return parts.join("/");
}
