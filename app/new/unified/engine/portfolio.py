import time
from typing import List, Optional

from tinkoff.invest import Client, InstrumentIdType

from engine import settings
from engine.client_factory import get_client
from engine.figi_cache import get_figi_info
from engine.logging_utils import get_logger
from engine.market_data import get_currency_rate, get_last_price, get_futures_go_per_lot
from engine.utils import money_value_to_float, quotation_to_float
from engine.token_utils import get_trade_token_for_account_id


logger = get_logger()


def get_portfolio_position(client: Client, figi: str) -> dict | None:
    portfolio = client.operations.get_portfolio(account_id=settings.ACCOUNT_ID)

    for pos in portfolio.positions:
        if pos.figi == figi:
            return {
                "quantity": pos.quantity.units,
                "avg_price": (
                    pos.average_position_price.units + pos.average_position_price.nano / 1e9
                ) if pos.average_position_price else None
            }
    return None


def get_blocked_funds_detailed(client: Client, account_id: str):
    try:
        positions = client.operations.get_positions(account_id=account_id)

        total_blocked_from_positions = 0.0
        blocked_list = getattr(positions, "blocked", None)
        if blocked_list:
            for m in blocked_list:
                total_blocked_from_positions += money_value_to_float(m)

        total_go_futures = 0.0
        futures_details = []
        futures_list = getattr(positions, "futures", None) or []
        for f in futures_list:
            go = money_value_to_float(getattr(f, "blocked", None))
            if go:
                total_go_futures += go
            figi = getattr(f, "figi", None) or "N/A"
            balance = getattr(f, "balance", None) or 0
            direction = "LONG" if balance > 0 else "SHORT" if balance < 0 else "—"
            estimated = False
            if not go and figi != "N/A":
                per_lot_go = get_futures_go_per_lot(client, figi)
                if per_lot_go is not None:
                    go = abs(balance) * per_lot_go
                    estimated = True
            futures_details.append({
                "figi": figi,
                "balance": balance,
                "direction": direction,
                "go": go,
                "estimated": estimated,
            })

        total_blocked_from_withdraw = 0.0
        blocked_guarantee = 0.0
        try:
            withdraw = client.operations.get_withdraw_limits(account_id=account_id)
            if withdraw:
                bl = getattr(withdraw, "blocked", None)
                if bl:
                    for m in bl:
                        total_blocked_from_withdraw += money_value_to_float(m)
                bg = getattr(withdraw, "blocked_guarantee", None)
                if bg:
                    for m in bg:
                        blocked_guarantee += money_value_to_float(m)
        except Exception as e:
            logger.debug(f"Не удалось получить withdraw_limits: {str(e)}")

        total_blocked = total_blocked_from_positions + total_blocked_from_withdraw + total_go_futures

        return {
            "total_blocked": total_blocked,
            "total_blocked_from_positions": total_blocked_from_positions,
            "total_blocked_from_withdraw": total_blocked_from_withdraw,
            "total_go_futures": total_go_futures,
            "blocked_guarantee": blocked_guarantee,
            "futures_details": futures_details,
            "other_blocked": total_blocked_from_positions + total_blocked_from_withdraw - blocked_guarantee,
        }
    except Exception as e:
        logger.error(f"Ошибка получения заблокированных средств: {str(e)}", exc_info=True)
        return {
            "total_blocked": 0.0,
            "total_blocked_from_positions": 0.0,
            "total_blocked_from_withdraw": 0.0,
            "total_go_futures": 0.0,
            "blocked_guarantee": 0.0,
            "futures_details": [],
            "other_blocked": 0.0,
        }


def get_blocked_funds(client: Client, account_id: str) -> float:
    detailed = get_blocked_funds_detailed(client, account_id)
    return detailed["total_blocked"]


def get_portfolio(client: Client, account_id: str, tickers_config: Optional[dict] = None):
    time.sleep(0.5)
    try:
        portfolio = client.operations.get_portfolio(account_id=account_id)

        trading_instruments_data = {}
        all_instruments_data = {}

        total_assets_value = 0
        tmon_value = 0

        total_portfolio_value = portfolio.total_amount_portfolio.units + portfolio.total_amount_portfolio.nano / 1e9
        available_cash = portfolio.total_amount_currencies.units + portfolio.total_amount_currencies.nano / 1e9

        for position in portfolio.positions:
            figi = position.figi
            quantity = int(position.quantity.units + position.quantity.nano / 1e9)
            avg_price = (
                position.average_position_price.units + position.average_position_price.nano / 1e9
                if hasattr(position, "average_position_price") else 0
            )
            current_price = get_last_price(client, figi) or 0

            figi_info = get_figi_info(client, figi)
            name = figi_info["name"]
            instrument_type = figi_info["type"]
            currency = figi_info["currency"]

            currency_rate = get_currency_rate(client, f"{currency.upper()}_RUB") if currency != "rub" else 1.0

            if instrument_type == "bond":
                try:
                    bond_info = client.instruments.bond_by(
                        id_type=InstrumentIdType.INSTRUMENT_ID_TYPE_FIGI,
                        id=figi
                    ).instrument
                    nominal = bond_info.nominal.units + bond_info.nominal.nano / 1e9
                    nkd = quotation_to_float(getattr(bond_info, "aci_value", None)) or 0.0
                except Exception:
                    nominal = 1000
                    nkd = 0.0

                value = ((current_price / 100 * nominal) + nkd) * quantity * currency_rate
            else:
                value = current_price * quantity * currency_rate

            all_instruments_data[figi] = {
                "name": name,
                "lots": quantity,
                "avg_price": avg_price,
                "current_price": current_price,
                "value": value,
                "currency": currency,
                "nkd": nkd if instrument_type == "bond" else 0.0,
            }

            total_assets_value += value

            tickers_cfg = tickers_config if tickers_config is not None else settings.TICKERS_CONFIG
            if figi in tickers_cfg:
                lot_size = tickers_cfg[figi].get("LOT_SIZE", 1)
                lots = quantity // lot_size if instrument_type == "share" else quantity
                trading_instruments_data[figi] = {
                    "lots": lots,
                    "avg_price": avg_price,
                    "accrued_interest": 0,
                }

            elif settings.TMON_FIGI and figi == settings.TMON_FIGI:
                tmon_value = value

        blocked_funds = get_blocked_funds(client, account_id)
        if settings.MAX_MARGIN < 0:
            required_cash = settings.MAX_MARGIN
        else:
            required_cash = settings.MAX_MARGIN + settings.MIN_CASH_RESERVE
        available_capital_for_buy = (available_cash + tmon_value - required_cash - blocked_funds) * settings.MAX_DAILY_CAPITAL_PERCENT

        if available_capital_for_buy < 0:
            logger.warning(
                "Доступный капитал стал отрицательным после учета заблокированных средств: "
                f"cash={available_cash:.2f}, tmon={tmon_value:.2f}, margin={settings.MAX_MARGIN:.2f}, "
                f"blocked={blocked_funds:.2f}, result={available_capital_for_buy:.2f}"
            )
            available_capital_for_buy = 0

        logger.debug(
            f"Расчет капитала: cash={available_cash:.2f}, tmon={tmon_value:.2f}, "
            f"margin={settings.MAX_MARGIN:.2f}, blocked={blocked_funds:.2f}, "
            f"available={available_capital_for_buy:.2f}"
        )

        _ = total_portfolio_value
        return trading_instruments_data, available_capital_for_buy, total_assets_value, tmon_value, all_instruments_data, True

    except Exception as e:
        logger.error(f"Ошибка портфеля: {str(e)}", exc_info=True)
        return {}, 0, 0, 0, {}, False


def build_status_messages_for_account(
    account_id: str,
    tickers_config: Optional[dict] = None,
    tmon_figi: Optional[str] = None,
) -> Optional[List[str]]:
    try:
        token = get_trade_token_for_account_id(account_id)
        if not token:
            return None
        with get_client(token) as client:
            _, capital, total_value, tmon_value, all_data, success = get_portfolio(
                client, account_id, tickers_config
            )
            if not success:
                return None

            lines = []
            for figi, data in all_data.items():
                nkd_line = ""
                if data.get("nkd"):
                    nkd_line = f"\n   НКД: {data['nkd']:.2f} руб."
                lines.append(
                    f"📃 {data['name']} ({figi})\n"
                    f"   Лотов: {data['lots']}\n"
                    f"   Средняя цена: {data['avg_price']:.2f} руб.\n"
                    f"   Текущая цена: {data['current_price']:.2f} руб.\n"
                    f"   Стоимость: {data['value']:.2f} руб."
                    f"{nkd_line}"
                )

            blocked_info = get_blocked_funds_detailed(client, account_id)

            status_header = (
                f"💰 Общая стоимость портфеля: {total_value:.2f} руб.\n"
                f"💵 Свободные средства: {capital:.2f} руб.\n"
                f"📊 TMON: {tmon_value:.2f} руб.\n"
                f"🔒 Заблокировано: {blocked_info['total_blocked']:.2f} руб.\n"
                f"   └─ ГО по фьючерсам: {blocked_info['total_go_futures']:.2f} руб.\n"
                f"   └─ Прочее: {blocked_info['other_blocked']:.2f} руб.\n"
            )

            assets_text = f"📋 Активы:\n{chr(10).join(lines) if lines else 'Нет активов'}"

            futures_text = ""
            if blocked_info["futures_details"]:
                futures_lines = []
                for fut in blocked_info["futures_details"]:
                    futures_lines.append(
                        f"   └─ {fut['figi']}: {abs(fut['balance'])} шт {fut['direction']}, ГО: {fut['go']:.2f} руб."
                    )
                futures_text = "\n🔒 Фьючерсы:\n" + "\n".join(futures_lines)

            full_status = status_header + assets_text + futures_text

            max_length = 4096
            if len(full_status) <= max_length:
                return [full_status]

            messages = [status_header + futures_text]
            current_part = ""
            parts = []
            for line in lines:
                test_length = len(current_part) + len(line) + 2
                if test_length <= max_length - 30:
                    current_part += line + "\n\n"
                else:
                    if current_part:
                        parts.append(current_part.rstrip())
                    current_part = line + "\n\n"
            if current_part:
                parts.append(current_part.rstrip())

            total_parts = len(parts)
            for i, part_content in enumerate(parts, 1):
                prefix = f"Активы (часть {i}/{total_parts}):\n\n"
                message = prefix + part_content
                if len(message) > max_length:
                    message = message[: max_length - 3] + "..."
                messages.append(message)

            return messages
    except Exception as e:
        logger.error(f"Ошибка status: {str(e)}", exc_info=True)
        return None


def build_status_messages() -> Optional[List[str]]:
    return build_status_messages_for_account(
        account_id=settings.ACCOUNT_ID,
        tickers_config=settings.TICKERS_CONFIG,
        tmon_figi=settings.TMON_FIGI,
    )


__all__ = [
    "get_portfolio_position",
    "get_blocked_funds_detailed",
    "get_blocked_funds",
    "get_portfolio",
    "build_status_messages_for_account",
    "build_status_messages",
]
