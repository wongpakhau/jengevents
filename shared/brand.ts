export function validLogoAddress(value: string): boolean {
  if (value === "") return true;
  if (
    /^\/manus-storage\/[A-Za-z0-9_./-]+$/.test(value) &&
    !value.includes("..")
  )
    return true;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      Boolean(url.hostname) &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}
