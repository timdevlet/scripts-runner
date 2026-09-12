import { useEffect } from "react";
import { api } from "../stores/api";

export function useOpenSettingsEvent(onOpen: () => void): void {
  useEffect(() => api.onOpenSettings(onOpen), [onOpen]);
}
