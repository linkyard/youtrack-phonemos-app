type AppLocation = {
  pathname: string;
  search: string;
  hash: string;
};

type AppAPI = {
  onRefresh?: () => void;
  onConfigure?: () => void;
  onAppLocationChange?: (location: AppLocation) => void;
}

import type AlertType from '@jetbrains/ring-ui-built/components/alert/alert';
import type {RequestParams} from '@jetbrains/ring-ui-built/components/http/http';

export interface HubService {
  id: string;
  applicationName: string;
  homeUrl: string;
}

interface BaseAPILayer {
  alert: (message: string, type?: AlertType | undefined, timeout?: number) => void;
  enterModalMode: () => Promise<void>;
  exitModalMode: () => Promise<void>;
  /** @deprecated use "closeWidget()" method instead */
  collapse: () => void;
  closeWidget: () => void;
}

/*
 * This layer should allow plugin to call YT endpoints while being sure there is just ONE YouTrack instance
 */
export interface InstanceAwareAPILayer extends BaseAPILayer {
  fetchYouTrack: <T = unknown>(relativeURL: string, requestParams?: RequestParams) => Promise<T>;
}

/*
 * This layer allows plugin to communicate with own backend
 */
export interface PluginEndpointAPILayer extends InstanceAwareAPILayer {
  fetchApp: <T = unknown>(relativeURL: string, requestParams?: RequestParams & {scope?: boolean}) => Promise<T>;
  /** Available for full-page widgets (MAIN_MENU_ITEM, ADMINISTRATION_MENU_ITEM). */
  navigation?: {
    getAppLocation: () => Promise<AppLocation>;
    updateAppLocation: (location: Partial<AppLocation>) => Promise<void>;
    replaceAppLocation: (location: Partial<AppLocation>) => Promise<void>;
  };
  /** Available since YouTrack 2026.2 — shared across widgets of the same app. */
  storage?: {
    getItem: (key: string) => Promise<string | null>;
    setItem: (key: string, value: string) => Promise<void>;
    removeItem: (key: string) => Promise<void>;
    clear: () => Promise<void>;
    getKeys: () => Promise<string[]>;
  };
}

/*
 * This layer is only available for MARKDOWN and DASHBOARD_WIDGET extension points
 */
export interface EmbeddableWidgetAPI extends PluginEndpointAPILayer {
  setTitle: (label: string, labelUrl: string) => Promise<void>;
  setLoadingAnimationEnabled: (isEnabled: boolean) => Promise<void>;

  enterConfigMode: () => Promise<void>;
  exitConfigMode: () => Promise<void>;

  setError: (e: Error) => Promise<void>;
  clearError: () => Promise<void>;

  readCache: <T = unknown>() => Promise<T | null>;
  storeCache: (data: unknown) => Promise<void>;

  readConfig: <T = unknown>() => Promise<T | null>;
  storeConfig: (config: unknown) => Promise<void>;

  downloadFile: (serviceID: string, relativeURL: string, requestParams: unknown, fileName?: string) => Promise<void>;
  fetchHub: (relativeURL: string, requestParams: RequestParams) => Promise<unknown>;

  loadServices: (applicationName: string) => Promise<HubService[]>;

  removeWidget: () => void;
}

export type HostAPI = PluginEndpointAPILayer;


type YTAppInterface = {
  locale: string;
  entity?: {
    id: string;
    type: 'user' | 'article' | 'ticket' | 'issue' | 'project' | 'app';
  };
  me?: {
    id: string;
    login: string;
    name: string;
    avatarUrl?: string;
    userType?: string;
  };
  register: (appApi?: AppAPI) => Promise<HostAPI | EmbeddableWidgetAPI>;
}

declare global {
  const YTApp: YTAppInterface;
}
