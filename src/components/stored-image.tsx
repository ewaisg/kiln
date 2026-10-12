import { useEffect, useState } from "react";
import { loadMedia } from "@/lib/library";

export function StoredImage({ id, alt }: { id: string; alt: string }) {
  const [url, setUrl] = useState("");
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let revoke = "";
    let dead = false;
    void loadMedia(id).then((blob) => {
      if (dead) return;
      if (!blob) {
        setMissing(true);
        return;
      }
      revoke = URL.createObjectURL(blob);
      setUrl(revoke);
    });
    return () => {
      dead = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [id]);

  if (missing) return <p className="text-sm text-faint">That picture is no longer stored on this device.</p>;
  if (!url) return <p className="text-sm text-faint">Loading picture…</p>;
  return <img src={url} alt={alt} className="mt-2 max-h-96 max-w-full rounded-md" />;
}
