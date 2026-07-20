import type { Server } from '../server'

export type ServerProcessSignal = 'SIGINT' | 'SIGTERM'

/** Process operations required by the server CLI lifecycle. */
export interface ServerProcessHost {
  /** Registers one process signal listener. */
  on: (signal: ServerProcessSignal, listener: () => void) => unknown
  /** Removes one process signal listener. */
  off: (signal: ServerProcessSignal, listener: () => void) => unknown
  /** Terminates the CLI after server cleanup completes. */
  exit: (code: number) => unknown
}

/** Configuration for bounded CLI-owned shutdown. */
export interface ServerProcessLifecycleOptions {
  /**
   * Maximum time allowed for in-flight requests to drain before active connections are closed.
   *
   * @default 500
   */
  gracefulTimeoutMs?: number
  /** Receives start or shutdown failures for structured CLI logging. */
  onError?: (error: unknown) => void
}

/**
 * Owns process signal registration and bounded shutdown for the server CLI.
 *
 * Use when:
 * - Running a {@link Server} as the top-level command-line process
 * - Preserving graceful close before escalating to active-connection termination
 *
 * Expects:
 * - Programmatic server instances do not register their own process listeners
 * - A second signal requests immediate active-connection termination
 *
 * Returns:
 * - A lifecycle that removes its listeners before requesting process exit
 */
export class ServerProcessLifecycle {
  private readonly gracefulTimeoutMs: number
  private readonly handleSignal = () => {
    if (this.shutdownTask) {
      this.observeSignalTask(this.forceShutdown())
      return
    }

    this.observeSignalTask(this.shutdown())
  }

  private attached = false
  private exitRequested = false
  private forceTask: Promise<void> | null = null
  private forceTimer: ReturnType<typeof setTimeout> | null = null
  private shutdownHadError = false
  private shutdownTask: Promise<void> | null = null

  constructor(
    private readonly server: Pick<Server, 'start' | 'stop'>,
    private readonly host: ServerProcessHost,
    private readonly options: ServerProcessLifecycleOptions = {},
  ) {
    // Bound operator configuration so a typo cannot disable forced shutdown forever
    // or turn an ordinary slow request into an immediate active-connection reset.
    this.gracefulTimeoutMs = Math.min(30_000, Math.max(100, options.gracefulTimeoutMs ?? 500))
  }

  /**
   * Starts the server after claiming CLI process-signal ownership.
   *
   * Use when:
   * - Booting the server-runtime executable
   *
   * Expects:
   * - Start failures leave no SIGINT or SIGTERM listener behind
   *
   * Returns:
   * - A promise resolved once the server is listening
   */
  async start(): Promise<void> {
    this.attach()
    try {
      await this.server.start()
    }
    catch (error) {
      this.detach()
      throw error
    }
  }

  /**
   * Begins graceful shutdown and escalates after the configured deadline.
   *
   * Use when:
   * - A SIGINT or SIGTERM requests CLI shutdown
   *
   * Expects:
   * - Repeated calls share one graceful task; a subsequent signal uses {@link forceShutdown}
   *
   * Returns:
   * - A promise resolved after graceful cleanup or forced close has been requested
   */
  shutdown(): Promise<void> {
    if (this.shutdownTask)
      return this.shutdownTask

    this.shutdownTask = this.runGracefulShutdown()
    return this.shutdownTask
  }

  private attach() {
    if (this.attached)
      return

    this.attached = true
    this.host.on('SIGINT', this.handleSignal)
    this.host.on('SIGTERM', this.handleSignal)
  }

  private detach() {
    if (!this.attached)
      return

    this.attached = false
    this.host.off('SIGINT', this.handleSignal)
    this.host.off('SIGTERM', this.handleSignal)
  }

  private finish(exitCode: number) {
    if (this.exitRequested)
      return

    this.exitRequested = true
    if (this.forceTimer) {
      clearTimeout(this.forceTimer)
      this.forceTimer = null
    }
    this.detach()
    this.host.exit(exitCode)
  }

  private reportError(error: unknown): unknown | undefined {
    this.shutdownHadError = true
    try {
      this.options.onError?.(error)
      return undefined
    }
    catch (observerError) {
      return observerError
    }
  }

  private observeSignalTask(task: Promise<void>) {
    // Signal callbacks cannot return a rejecting promise to Node. Any observer
    // failure is still exposed by exit status after shutdown() has propagated
    // it to direct callers, while this terminal handler prevents an unhandled
    // rejection from bypassing listener teardown.
    void task.catch(() => this.finish(1))
  }

  private forceShutdown(): Promise<void> {
    if (this.forceTask)
      return this.forceTask

    if (this.forceTimer) {
      clearTimeout(this.forceTimer)
      this.forceTimer = null
    }

    this.forceTask = (async () => {
      try {
        await this.server.stop(true)
        this.finish(this.shutdownHadError ? 1 : 0)
      }
      catch (error) {
        const observerError = this.reportError(error)
        this.finish(1)
        if (observerError !== undefined) {
          throw new AggregateError(
            [error, observerError],
            'Server shutdown error observation failed.',
          )
        }
      }
    })()
    return this.forceTask
  }

  private async runGracefulShutdown() {
    // The timer is unreferenced in production so it cannot keep an otherwise
    // drained CLI alive; the active server remains the lifecycle owner.
    this.forceTimer = setTimeout(() => {
      this.observeSignalTask(this.forceShutdown())
    }, this.gracefulTimeoutMs)
    this.forceTimer.unref()

    try {
      await this.server.stop(false)
      if (this.forceTask)
        await this.forceTask
      else
        this.finish(0)
    }
    catch (error) {
      const observerError = this.reportError(error)
      await this.forceShutdown()
      if (observerError !== undefined) {
        throw new AggregateError(
          [error, observerError],
          'Server shutdown error observation failed.',
        )
      }
    }
  }
}
