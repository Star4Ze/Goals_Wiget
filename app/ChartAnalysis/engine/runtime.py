class RuntimeState:
    def __init__(self):
        self.bot_running = True
        self.bot_paused = False
        self.rebalance_requested = False


__all__ = ["RuntimeState"]
