// Primitive states gallery (plan I0; ported from the gap audit's
// scratch/visual-audit/gaps/states). Every control carries
//   data-ctl="<primitive>:<variant>"   which control
//   data-src="<state>"                  the state rendered statically
// (default, disabled, aria-disabled, loading, error, selected, checked,
// checked-disabled). Hover, keyboard focus and pressed are produced by the
// runner (states/run.mjs) on the `default`/`selected`/`checked` instances.
// The F2a state contract (states/judge.mjs) holds every `button:`,
// `input:`, `textarea:`, `select:` and `switch:` control: all Button
// variants and sizes, the Input variants and sizes, controls inside a Field
// with help and error text. Not part of the app build or tsc (scripts/ is
// outside tsconfig.app.json).
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";
import { Settings } from "lucide-react";
import "./states.css";
import "@/i18n";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Spinner } from "@/components/ui/spinner";
import { Notice } from "@/components/ui/notice";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
} from "@/components/ui/dropdown-menu";

const query = new URLSearchParams(location.search);
if (query.get("theme") === "dark") document.documentElement.classList.add("dark");

const BUTTON_VARIANTS = ["default", "destructive", "outline", "secondary", "ghost", "link", "accent", "success", "warning"] as const;
const BUTTON_SIZES = [
  { ctl: "sm", size: "sm", variant: "default" },
  { ctl: "lg", size: "lg", variant: "default" },
  { ctl: "icon", size: "icon", variant: "ghost" },
  { ctl: "icon-sm", size: "icon-sm", variant: "ghost" },
  { ctl: "icon-lg", size: "icon-lg", variant: "outline" },
] as const;
const BADGE_VARIANTS = ["neutral", "muted", "danger", "warning", "info", "outline"] as const;
const BADGE_LEGACY = ["default", "secondary", "destructive", "accent", "success"] as const;
const NOTICE_VARIANTS = ["neutral", "info", "warning", "danger", "success"] as const;
const CARD_VARIANTS = ["default", "elevated", "interactive", "glass", "outline"] as const;

function Row({ id, label, children }: { id: string; label: string; children: ReactNode }) {
  return (
    <div data-row={id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "6px 0" }}>
      <div style={{ width: 150, flex: "none", fontSize: 11, fontFamily: "monospace" }} className="text-muted-foreground">
        {label}
      </div>
      {children}
    </div>
  );
}

function ButtonSizeContent({ ctl }: { ctl: string }) {
  return ctl.startsWith("icon") ? <Settings /> : ctl === "sm" ? "Small" : "Large";
}

function App() {
  return (
    <div className="bg-background text-foreground min-h-screen p-6" style={{ width: 1100 }} data-gallery-ready="true">
      {BUTTON_VARIANTS.map((v) => (
        <Row key={v} id={`button-${v}`} label={`Button ${v}`}>
          <Button data-ctl={`button:${v}`} data-src="default" variant={v}>Save</Button>
          <Button data-ctl={`button:${v}`} data-src="disabled" variant={v} disabled>Save</Button>
          <Button data-ctl={`button:${v}`} data-src="aria-disabled" variant={v} aria-disabled="true">Save</Button>
          <Button data-ctl={`button:${v}`} data-src="loading" variant={v} loading>Save</Button>
        </Row>
      ))}
      <Row id="button-sizes" label="Button sizes">
        {BUTTON_SIZES.map(({ ctl, size, variant }) => (
          <span key={ctl} style={{ display: "inline-flex", gap: 8 }}>
            <Button data-ctl={`button:${ctl}`} data-src="default" size={size} variant={variant} aria-label={ctl.startsWith("icon") ? "Settings" : undefined}>
              <ButtonSizeContent ctl={ctl} />
            </Button>
            <Button data-ctl={`button:${ctl}`} data-src="loading" size={size} variant={variant} loading aria-label={ctl.startsWith("icon") ? "Settings" : undefined}>
              <ButtonSizeContent ctl={ctl} />
            </Button>
          </span>
        ))}
      </Row>
      <Row id="input" label="Input">
        <Input data-ctl="input:default" data-src="default" placeholder="Search" style={{ width: 160 }} />
        <Input data-ctl="input:default" data-src="disabled" disabled placeholder="Search" style={{ width: 160 }} />
        <Input data-ctl="input:default" data-src="error" aria-invalid="true" defaultValue="bad value" style={{ width: 160 }} />
        <Input data-ctl="input:ghost" data-src="default" variant="ghost" placeholder="Ghost" style={{ width: 120 }} />
        <Input data-ctl="input:sm" data-src="default" inputSize="sm" placeholder="Small" style={{ width: 100 }} />
        <Input data-ctl="input:lg" data-src="default" inputSize="lg" placeholder="Large" style={{ width: 120 }} />
      </Row>
      <Row id="field" label="Field">
        <div style={{ width: 220 }}>
          <Field label="Name" help="Shown on the card">
            <Input data-ctl="input:field" data-src="default" placeholder="Session name" />
          </Field>
        </div>
        <div style={{ width: 220 }}>
          <Field label="Name" error="Enter a name">
            <Input data-ctl="input:error" data-src="default" defaultValue="" />
          </Field>
        </div>
        <div style={{ width: 220 }}>
          <Field label="Range" help="Days to include" error="Pick a range">
            <Select defaultValue="a">
              <SelectTrigger data-ctl="select:error" data-src="default"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="a">All time</SelectItem></SelectContent>
            </Select>
          </Field>
        </div>
      </Row>
      <Row id="textarea" label="Textarea">
        <Textarea data-ctl="textarea:default" data-src="default" placeholder="Notes" style={{ width: 220, minHeight: 40 }} />
        <Textarea data-ctl="textarea:default" data-src="disabled" disabled style={{ width: 220, minHeight: 40 }} />
        <div style={{ width: 220 }}>
          <Field label="Notes" error="Too long">
            <Textarea data-ctl="textarea:error" data-src="default" defaultValue="bad value" style={{ minHeight: 40 }} />
          </Field>
        </div>
      </Row>
      <Row id="select" label="Select">
        <div style={{ width: 180 }}>
          <Select defaultValue="a">
            <SelectTrigger data-ctl="select:default" data-src="default" aria-label="Range"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="a">All time</SelectItem><SelectItem value="b">Last 7 days</SelectItem></SelectContent>
          </Select>
        </div>
        <div style={{ width: 180 }}>
          <Select defaultValue="a" disabled>
            <SelectTrigger data-ctl="select:default" data-src="disabled" aria-label="Range (disabled)"><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="a">All time</SelectItem></SelectContent>
          </Select>
        </div>
      </Row>
      <Row id="switch" label="Switch">
        <Switch data-ctl="switch:default" data-src="default" aria-label="a" />
        <Switch data-ctl="switch:default" data-src="checked" defaultChecked aria-label="b" />
        <Switch data-ctl="switch:default" data-src="disabled" disabled aria-label="c" />
        <Switch data-ctl="switch:default" data-src="checked-disabled" disabled defaultChecked aria-label="d" />
      </Row>
      <Row id="spinner" label="Spinner">
        <Spinner data-ctl="spinner:14" data-src="default" size={14} />
        <Spinner data-ctl="spinner:16" data-src="default" />
        <Spinner data-ctl="spinner:24" data-src="default" size={24} />
        <span className="text-list text-fg-2" style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
          <Spinner decorative /> Loading sessions
        </span>
      </Row>
      <Row id="badge" label="Badge">
        {BADGE_VARIANTS.map((v) => (
          <Badge key={v} variant={v} data-ctl={`badge:${v}`} data-src="default">{v}</Badge>
        ))}
      </Row>
      <Row id="badge-legacy" label="Badge (older names)">
        {BADGE_LEGACY.map((v) => (
          <Badge key={v} variant={v} data-ctl={`badge:${v}`} data-src="default">{v}</Badge>
        ))}
      </Row>
      <Row id="notice" label="Notice">
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 290px)", gap: 8 }}>
          {NOTICE_VARIANTS.map((v) => (
            <Notice key={v} variant={v} title={`${v[0]!.toUpperCase()}${v.slice(1)} notice`} data-ctl={`notice:${v}`} data-src="default">
              One line of detail.
            </Notice>
          ))}
          <Notice variant="danger" live data-ctl="notice:live" data-src="default">Could not save the file (live)</Notice>
        </div>
      </Row>
      <Row id="tabs" label="Tabs">
        <Tabs defaultValue="o">
          <TabsList>
            <TabsTrigger value="o" data-ctl="tabs:trigger" data-src="selected">Overview</TabsTrigger>
            <TabsTrigger value="b" data-ctl="tabs:trigger" data-src="default">Browse</TabsTrigger>
            <TabsTrigger value="c" data-ctl="tabs:trigger" data-src="disabled" disabled>Locked</TabsTrigger>
          </TabsList>
        </Tabs>
      </Row>
      <Row id="segmented" label=".segmented">
        <div className="segmented" role="group">
          <button className="segmented-item px-3 py-1 text-list" aria-pressed="true" data-ctl="segmented:item" data-src="selected">Overview</button>
          <button className="segmented-item px-3 py-1 text-list" aria-pressed="false" data-ctl="segmented:item" data-src="default">Tokens</button>
          <button className="segmented-item px-3 py-1 text-list" aria-pressed="false" disabled data-ctl="segmented:item" data-src="disabled">Edits</button>
        </div>
      </Row>
      <Row id="card" label="Card">
        {CARD_VARIANTS.map((v) => (
          <Card key={v} variant={v} data-ctl={`card:${v}`} data-src="default" tabIndex={v === "interactive" ? 0 : undefined} style={{ padding: 12, width: 120, fontSize: 13 }}>
            {v}
          </Card>
        ))}
      </Row>
      <Row id="menu" label="DropdownMenu">
        <DropdownMenu open modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" data-ctl="menu:trigger" data-src="default">Menu</Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom" avoidCollisions={false}>
            <DropdownMenuItem data-ctl="menu:item" data-src="default">Open in new tab</DropdownMenuItem>
            <DropdownMenuItem data-ctl="menu:item" data-src="disabled" disabled>Delete</DropdownMenuItem>
            <DropdownMenuCheckboxItem checked data-ctl="menu:checkbox" data-src="checked">Show minimap</DropdownMenuCheckboxItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </Row>
      <div style={{ height: 260 }} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
