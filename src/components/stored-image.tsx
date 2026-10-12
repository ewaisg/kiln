import { useEffect, useState } from "react";
import { loadMedia } from "@/lib/library";

export function StoredImage({ id, alt }: { id: string; alt: string }) {
  const [url, setUrl] = useState("");
  const [missing, setMissing] = useState(false);
  const [extension, setExtension] = useState("png");

  useEffect(() => {
    let revoke = "";
    let dead = false;
    setMissing(false);
    void loadMedia(id)
      .then((blob) => {
        if (dead) return;
        if (!blob) {
          setMissing(true);
          return;
        }
        revoke = URL.createObjectURL(blob);
        setExtension(
          blob.type.includes("jpeg") ? "jpg" : blob.type.includes("webp") ? "webp" : "png",
        );
        setUrl(revoke);
      })
      .catch(() => {
        if (!dead) setMissing(true);
      });
    return () => {
      dead = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [id]);

  if (missing)
    return <p className="text-sm text-faint">That picture is no longer stored on this device.</p>;
  if (!url) return <p className="text-sm text-faint">Loading picture…</p>;
  return (
    <figure className="mt-2">
      <img src={url} alt={alt} className="max-h-96 max-w-full rounded-md" />
      <figcaption className="mt-2">
        <a
          href={url}
          download={`kiln-${id}.${extension}`}
          className="inline-flex min-h-11 items-center rounded-md border border-line px-3 text-sm"
          aria-label="Download generated image"
        >
          Download image
        </a>
      </figcaption>
    </figure>
  );
}
