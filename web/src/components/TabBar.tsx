import type { Tab } from "../nav";
import { T } from "../i18n";
import { cx } from "../util";
import { Icon } from "./Icon";

/** Floating pill bar: chats, home, devices (in RTL the first item is on the right). */
export function TabBar({ tab, onTab }: { tab: Tab; onTab: (t: Tab) => void }) {
  return (
    <>
      <div class="tab-fade" aria-hidden="true" />
      <nav class="tab-bar" aria-label={T.mainNav}>
        <button type="button" class={cx("tab", tab === "chats" && "on")} aria-current={tab === "chats" ? "page" : undefined} onClick={() => onTab("chats")}>
          <span class="tab-icon">
            <Icon name="messages" size={24} />
          </span>
          <span class="tab-label">{T.tabChats}</span>
        </button>
        <button type="button" class={cx("tab hub", tab === "home" && "on")} aria-current={tab === "home" ? "page" : undefined} onClick={() => onTab("home")}>
          <span class="hub-circle">
            <Icon name="house" size={28} />
          </span>
          <span class="tab-label">{T.tabHome}</span>
        </button>
        <button type="button" class={cx("tab", tab === "devices" && "on")} aria-current={tab === "devices" ? "page" : undefined} onClick={() => onTab("devices")}>
          <span class="tab-icon">
            <Icon name="devices" size={24} />
          </span>
          <span class="tab-label">{T.tabDevices}</span>
        </button>
      </nav>
    </>
  );
}
