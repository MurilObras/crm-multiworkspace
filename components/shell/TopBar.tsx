"use client";
import { AlertsBell } from "./AlertsBell";
import { MobileSidebar } from "./MobileSidebar";
import { TenantSwitcher } from "./TenantSwitcher";
import { UserMenu } from "./UserMenu";
import { SearchTrigger } from "./SearchTrigger";

export function TopBar() {
  return (
    <header className="shell-topbar sticky top-0 z-20 flex h-14 shrink-0 items-center justify-between gap-2 border-b bg-background/95 px-3 md:gap-4 md:px-6">
      <div className="shell-topbar-identity flex min-w-0 flex-1 items-center gap-1 md:flex-none md:gap-2">
        <MobileSidebar />
        <TenantSwitcher />
      </div>
      <div className="shell-search flex shrink-0 justify-center md:max-w-md md:min-w-0 md:flex-1">
        <SearchTrigger />
      </div>
      <div className="flex shrink-0 items-center gap-1 md:gap-2">
        <AlertsBell />
        <UserMenu />
      </div>
    </header>
  );
}
