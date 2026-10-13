import { Component, type ComponentType, type ReactNode } from "react";
import type { App } from "./plugin-api.ts";
import type { Host } from "./pluginHost.ts";

interface ContainedProps {
  /** What is being drawn. A new one gets a fresh try, such as after its plugin was turned off and on. */
  subject: object;
  onError: (error: unknown) => void;
  fallback: ReactNode;
  children: ReactNode;
}

/** Keeps what is inside from taking the rest of the app down when it throws while being drawn. */
class Contained extends Component<ContainedProps, { failed: boolean; subject: object | null }> {
  override state = { failed: false, subject: null };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  static getDerivedStateFromProps(props: ContainedProps, state: { subject: object | null }) {
    return props.subject === state.subject ? null : { failed: false, subject: props.subject };
  }

  override componentDidCatch(error: unknown) {
    this.props.onError(error);
  }

  override render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

type Props<P> = Omit<P, "app"> & {
  host: Host;
  view: { id: string; component: ComponentType<P> };
  /** What to show in its place if it throws. Nothing, unless said. */
  fallback?: ReactNode;
  /** What the view is told of the app in place of what its plugin is given, such as a page that is told its own address. */
  as?: (app: App) => App;
};

/**
 * Draws one view a plugin registered, with the `app` its own plugin is given. A view that throws is
 * left out, and the failure is recorded against its plugin.
 */
export function Drawn<P extends { app: App }>({ host, view, fallback = null, as, ...props }: Props<P>) {
  const View = view.component as ComponentType<{ app: App }>;
  return (
    <Contained subject={view} onError={(error) => host.fail(view, error)} fallback={fallback}>
      <View {...props} app={as ? as(host.appFor(view)) : host.appFor(view)} />
    </Contained>
  );
}
