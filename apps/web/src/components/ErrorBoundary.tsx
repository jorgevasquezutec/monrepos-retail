import { Component, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /** Mensaje en español mostrado al fallar. */
  message: string;
  /** Se llama antes de reintentar (p. ej. para recrear el import perezoso). */
  onReset?: () => void;
}

/** Captura fallos de render/carga de chunks perezosos sin tumbar toda la app. */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  private retry = () => {
    this.props.onReset?.();
    this.setState({ failed: false });
  };

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="live-loading kicker" role="alert">
        {this.props.message}{" "}
        <button className="ghost-btn" onClick={this.retry}>
          Reintentar
        </button>
      </div>
    );
  }
}
