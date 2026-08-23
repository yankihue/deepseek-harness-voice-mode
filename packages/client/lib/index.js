/**
 * deepseek-voice-mode UI, node half. Pure UI plugin host face: exists so the
 * plugin appears in the host Loader; the browser half ships via
 * exports["./client"], discovered through the package.json dsh.client decl.
 */
function apply() {}
export default apply;
export { apply };
