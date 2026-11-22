"""Swiggy business xlsx -> CSV (one sheet, displayed text values), in memory only."""
import csv, io, warnings
def swiggy_xlsx_to_csv(data: bytes) -> str:
    import openpyxl
    with warnings.catch_warnings():
        warnings.simplefilter('ignore')
        wb = openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True)
    if len(wb.sheetnames) != 1: raise ValueError('expected one sheet')
    ws = wb[wb.sheetnames[0]]
    out = io.StringIO(); w = csv.writer(out, lineterminator='\r\n')
    for row in ws.iter_rows(values_only=True):
        w.writerow(['' if v is None else str(v) for v in row])
    wb.close()
    return out.getvalue()
