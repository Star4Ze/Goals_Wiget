"""
Заготовка под Short-логику и хедж.

Планируемые элементы:
- Режимы: LONG / SHORT / BOTH
- Расчёт баз для short-сетки
- Контроль рисков и лимитов
- Хеджирующий элемент (например, через фьючерсы или коррелирующие активы)
"""


class ShortEngine:
    def __init__(self, figi: str, cfg: dict):
        self.figi = figi
        self.cfg = cfg

    def build_short_plan(self, context: dict):
        raise NotImplementedError("Short-логика будет добавлена после утверждения сценария.")
