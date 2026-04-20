export function delay(ms: number) {
  return new Promise((resolve) => {
    setTimeout(() => resolve("Done!"), ms);
  });
}
