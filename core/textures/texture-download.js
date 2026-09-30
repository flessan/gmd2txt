export function downloadTextureBlob(bytes, filename, mime) {
  const blob = new Blob([bytes], { type: mime }), url = URL.createObjectURL(blob), link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
