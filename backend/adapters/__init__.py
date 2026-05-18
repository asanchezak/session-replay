from adapters.odoo.adapter import OdooAdapter
from adapters.registry import register

register("odoo", OdooAdapter)
