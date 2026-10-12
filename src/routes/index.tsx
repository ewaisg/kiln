import { createFileRoute } from "@tanstack/react-router";
import { KilnApp } from "@/components/kiln-app";

export const Route = createFileRoute("/")({
  component: KilnApp,
});
