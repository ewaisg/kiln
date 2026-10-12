export function huggingFaceUrl(repo: string, file: string): string {
  const name = file.split("/").map(encodeURIComponent).join("/");
  return `https://huggingface.co/${repo}/resolve/main/${name}`;
}
