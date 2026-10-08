from http.server import ThreadingHTTPServer,SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse
import sqlite3,json,secrets,hashlib,os,datetime
ROOT=Path(__file__).resolve().parent
DB=ROOT/'mix0grau.db'
ADMIN_PIN=os.getenv('MIX0GRAU_ADMIN_PIN','')
PORT=int(os.getenv('MIX0GRAU_PORT','8080'))
PRODUCT_DEFAULTS=[
 ('Morango Trufado','Açaí cremoso com morango e uma camada trufada bem generosa.','Trufados',17,24),
 ('Maracujá Trufado','A combinação azedinha do maracujá com trufa doce na medida.','Trufados',17,24),
 ('Ninho Trufado','Creme de Ninho com toque trufado para um açaí mais encorpado.','Trufados',16,23),
 ('Morango com Ninho','Morango e leite Ninho em uma mistura leve, doce e cremosa.','Ninho',15,20),
 ('Maracujá com Ninho','Maracujá refrescante com Ninho para equilibrar doçura e acidez.','Ninho',15,20),
 ('Paçoca com Ninho','Açaí com paçoca e Ninho, sabor de sobremesa brasileira.','Ninho',12,18),
 ('Tradicional','O clássico com Ninho e leite condensado, simples e certeiro.','Tradicional',12,16),
 ('Creme de Ninho','Açaí com creme de Ninho macio, doce e bem aconchegante.','Ninho',12,18),
]
def db():
 c=sqlite3.connect(DB);c.row_factory=sqlite3.Row
 c.execute('CREATE TABLE IF NOT EXISTS clients(id INTEGER PRIMARY KEY,name TEXT NOT NULL,phone TEXT NOT NULL UNIQUE,token_hash TEXT NOT NULL,created TEXT DEFAULT CURRENT_TIMESTAMP)')
 cols=[x['name'] for x in c.execute('PRAGMA table_info(clients)')]
 if 'address' not in cols:c.execute('ALTER TABLE clients ADD COLUMN address TEXT DEFAULT ""')
 c.execute('CREATE TABLE IF NOT EXISTS orders(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL,items TEXT NOT NULL,total REAL NOT NULL,units INTEGER NOT NULL,status TEXT NOT NULL DEFAULT "pending",reward INTEGER NOT NULL DEFAULT 0,created TEXT DEFAULT CURRENT_TIMESTAMP)')
 c.execute('CREATE TABLE IF NOT EXISTS redemptions(id INTEGER PRIMARY KEY,client_id INTEGER NOT NULL,created TEXT DEFAULT CURRENT_TIMESTAMP)')
 c.execute('CREATE TABLE IF NOT EXISTS products(id INTEGER PRIMARY KEY,name TEXT NOT NULL,description TEXT DEFAULT "",category TEXT DEFAULT "Açaí",active INTEGER DEFAULT 1,price350 REAL,price500 REAL,cost REAL DEFAULT 0,stock REAL DEFAULT 0,low_stock REAL DEFAULT 5,created TEXT DEFAULT CURRENT_TIMESTAMP)')
 c.execute('CREATE TABLE IF NOT EXISTS stock_movements(id INTEGER PRIMARY KEY,product_id INTEGER,delta REAL,reason TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP)')
 c.execute('CREATE TABLE IF NOT EXISTS expenses(id INTEGER PRIMARY KEY,description TEXT,amount REAL,category TEXT,created TEXT DEFAULT CURRENT_TIMESTAMP)')
 if c.execute('SELECT COUNT(*) FROM products').fetchone()[0]==0:
  c.executemany('INSERT INTO products(name,description,category,price350,price500) VALUES(?,?,?,?,?)',PRODUCT_DEFAULTS)
 for name,description,category,_,_ in PRODUCT_DEFAULTS:
  c.execute('UPDATE products SET description=CASE WHEN description IS NULL OR TRIM(description)="" THEN ? ELSE description END, category=CASE WHEN category IS NULL OR TRIM(category)="" OR category IN ("Açaí","AÃ§aÃ­") THEN ? ELSE category END WHERE name=?',(description,category,name))
 c.commit();return c
def hash_token(s):return hashlib.sha256(s.encode()).hexdigest()
def public_client(c,client):
 paid=c.execute("SELECT COALESCE(SUM(units),0) FROM orders WHERE client_id=? AND status='approved' AND reward=0",(client['id'],)).fetchone()[0]
 redeemed=c.execute('SELECT COUNT(*) FROM redemptions WHERE client_id=?',(client['id'],)).fetchone()[0]
 return {'name':client['name'],'phone':client['phone'],'address':client['address'] or '','stamps':max(0,paid-redeemed*6)%6,'rewards':max(0,(paid-redeemed*6)//6),'total_approved':paid,'redeemed':redeemed}
class Handler(SimpleHTTPRequestHandler):
 def __init__(self,*a,**kw):super().__init__(*a,directory=str(ROOT),**kw)
 def send_json(self,obj,status=200):
  data=json.dumps(obj,ensure_ascii=False).encode();self.send_response(status);self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(data)));self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
 def payload(self):
  n=int(self.headers.get('Content-Length','0'));
  if n<=0 or n>100000:raise ValueError('Corpo ausente ou grande demais')
  return json.loads(self.rfile.read(n))
 def client(self,c):
  t=self.headers.get('Authorization','').removeprefix('Bearer ').strip()
  return c.execute('SELECT * FROM clients WHERE token_hash=?',(hash_token(t),)).fetchone() if t else None
 def admin(self):return bool(ADMIN_PIN) and secrets.compare_digest(self.headers.get('X-Admin-Pin',''),ADMIN_PIN)
 def do_GET(self):
  path=urlparse(self.path).path
  if path=='/api/me':
   with db() as c:
    cl=self.client(c);return self.send_json(public_client(c,cl) if cl else {'error':'Não autenticado'},200 if cl else 401)
  if path=='/api/products':
   with db() as c:return self.send_json([dict(x) for x in c.execute('SELECT id,name,description,category,price350,price500 FROM products WHERE active=1 ORDER BY id')])
  if path.startswith('/api/admin/erp/'):
   if not self.admin():return self.send_json({'error':'PIN inválido'},403)
   with db() as c:
    if path.endswith('/products'):return self.send_json([dict(x) for x in c.execute('SELECT * FROM products ORDER BY id DESC')])
    if path.endswith('/clients'):
     return self.send_json([dict(x)|public_client(c,x) for x in c.execute('SELECT * FROM clients ORDER BY id DESC LIMIT 500')])
    if path.endswith('/expenses'):return self.send_json([dict(x) for x in c.execute('SELECT * FROM expenses ORDER BY id DESC LIMIT 200')])
    if path.endswith('/movements'):return self.send_json([dict(x) for x in c.execute('SELECT m.*,p.name FROM stock_movements m LEFT JOIN products p ON p.id=m.product_id ORDER BY m.id DESC LIMIT 100')])
    if path.endswith('/dashboard'):
     stats=dict(c.execute("SELECT COUNT(*) orders,COALESCE(SUM(CASE WHEN status='approved' THEN total ELSE 0 END),0) revenue,COALESCE(SUM(CASE WHEN status='approved' THEN units ELSE 0 END),0) units, SUM(CASE WHEN status='pending' THEN 1 ELSE 0 END) pending FROM orders").fetchone())
     stats['expenses']=c.execute('SELECT COALESCE(SUM(amount),0) FROM expenses').fetchone()[0]
     stats['clients']=c.execute('SELECT COUNT(*) FROM clients').fetchone()[0]
     stats['low_stock']=[dict(x) for x in c.execute('SELECT name,stock,low_stock FROM products WHERE active=1 AND stock<=low_stock')]
     return self.send_json(stats)
  if path=='/api/admin/orders':
   if not self.admin():return self.send_json({'error':'PIN inválido'},403)
   with db() as c:
    rows=c.execute('SELECT orders.*,clients.name,clients.phone,clients.address FROM orders JOIN clients ON clients.id=orders.client_id ORDER BY orders.id DESC LIMIT 100').fetchall()
    return self.send_json([dict(x) for x in rows])
  return super().do_GET()
 def do_POST(self):
  path=urlparse(self.path).path
  try:data=self.payload()
  except Exception:return self.send_json({'error':'JSON inválido'},400)
  with db() as c:
   if path=='/api/admin/erp/product':
    if not self.admin():return self.send_json({'error':'PIN inválido'},403)
    name=str(data.get('name','')).strip()[:100]
    if len(name)<2:return self.send_json({'error':'Informe o nome do produto'},400)
    try:
     price350=float(data.get('price350',0));price500=float(data.get('price500',0));cost=float(data.get('cost',0));low=float(data.get('low_stock',5))
     if min(price350,price500,cost,low)<0:return self.send_json({'error':'Valores negativos não permitidos'},400)
    except (TypeError,ValueError):return self.send_json({'error':'Preços inválidos'},400)
    fields=(name,str(data.get('description',''))[:200],str(data.get('category','Açaí'))[:60],price350,price500,cost,low,int(bool(data.get('active',True))))
    pid=int(data.get('id') or 0)
    if pid:
     cur=c.execute('UPDATE products SET name=?,description=?,category=?,price350=?,price500=?,cost=?,low_stock=?,active=? WHERE id=?',fields+(pid,))
     if not cur.rowcount:return self.send_json({'error':'Produto não encontrado'},404)
    else:c.execute('INSERT INTO products(name,description,category,price350,price500,cost,low_stock,active) VALUES(?,?,?,?,?,?,?,?)',fields)
    c.commit();return self.send_json({'ok':True})
   if path=='/api/admin/erp/stock':
    if not self.admin():return self.send_json({'error':'PIN inválido'},403)
    try:pid=int(data['id']);delta=float(data['delta'])
    except (KeyError,TypeError,ValueError):return self.send_json({'error':'Movimentação inválida'},400)
    if not -100000<=delta<=100000 or delta==0:return self.send_json({'error':'Quantidade inválida'},400)
    row=c.execute('SELECT stock FROM products WHERE id=?',(pid,)).fetchone()
    if not row:return self.send_json({'error':'Produto não encontrado'},404)
    if row['stock']+delta<0:return self.send_json({'error':'Estoque insuficiente'},400)
    c.execute('UPDATE products SET stock=stock+? WHERE id=?',(delta,pid))
    c.execute('INSERT INTO stock_movements(product_id,delta,reason) VALUES(?,?,?)',(pid,delta,str(data.get('reason','Ajuste manual'))[:100]))
    c.commit();return self.send_json({'ok':True})
   if path=='/api/admin/erp/expense':
    if not self.admin():return self.send_json({'error':'PIN inválido'},403)
    try:amount=float(data.get('amount',0))
    except (TypeError,ValueError):return self.send_json({'error':'Valor inválido'},400)
    if not 0<amount<1000000:return self.send_json({'error':'Valor inválido'},400)
    desc=str(data.get('description','')).strip()[:150]
    if not desc:return self.send_json({'error':'Informe descrição'},400)
    c.execute('INSERT INTO expenses(description,amount,category) VALUES(?,?,?)',(desc,amount,str(data.get('category','Outros'))[:60]));c.commit();return self.send_json({'ok':True})
   if path=='/api/admin/erp/expense_edit':
    if not self.admin():return self.send_json({'error':'PIN inválido'},403)
    eid=int(data.get('id') or 0)
    try:amount=float(data.get('amount',0))
    except (TypeError,ValueError):return self.send_json({'error':'Valor inválido'},400)
    desc=str(data.get('description','')).strip()[:150]
    if not eid or not desc or not 0<amount<1000000:return self.send_json({'error':'Dados da despesa inválidos'},400)
    cur=c.execute('UPDATE expenses SET description=?,amount=?,category=? WHERE id=?',(desc,amount,str(data.get('category','Outros'))[:60],eid));c.commit()
    return self.send_json({'ok':bool(cur.rowcount)})
   if path=='/api/admin/erp/expense_delete':
    if not self.admin():return self.send_json({'error':'PIN inválido'},403)
    eid=int(data.get('id') or 0)
    cur=c.execute('DELETE FROM expenses WHERE id=?',(eid,));c.commit()
    return self.send_json({'ok':bool(cur.rowcount)})
   if path=='/api/admin/erp/client':
    if not self.admin():return self.send_json({'error':'PIN inválido'},403)
    cid=int(data.get('id') or 0);name=str(data.get('name','')).strip()[:80];phone=''.join(x for x in str(data.get('phone','')) if x.isdigit());address=str(data.get('address','')).strip()[:180]
    if not cid or len(name)<2 or len(phone)<10 or len(phone)>13:return self.send_json({'error':'Dados do cliente inválidos'},400)
    other=c.execute('SELECT id FROM clients WHERE phone=? AND id<>?',(phone,cid)).fetchone()
    if other:return self.send_json({'error':'Este WhatsApp já está em outro cadastro'},400)
    cur=c.execute('UPDATE clients SET name=?,phone=?,address=? WHERE id=?',(name,phone,address,cid));c.commit()
    return self.send_json({'ok':bool(cur.rowcount)})
   if path=='/api/login':
    name=str(data.get('name','')).strip()[:80];phone=''.join(x for x in str(data.get('phone','')) if x.isdigit());address=str(data.get('address','')).strip()[:180]
    if len(name)<2 or len(phone)<10 or len(phone)>13:return self.send_json({'error':'Informe nome e WhatsApp válido'},400)
    token=secrets.token_urlsafe(32)
    row=c.execute('SELECT * FROM clients WHERE phone=?',(phone,)).fetchone()
    if row:
     # Demo-only registration: existing phone can be re-entered. Production requires OTP verification.
     saved_address=address or row['address'] or ''
     c.execute('UPDATE clients SET name=?,address=?,token_hash=? WHERE id=?',(name,saved_address,hash_token(token),row['id']))
    else:c.execute('INSERT INTO clients(name,phone,address,token_hash) VALUES(?,?,?,?)',(name,phone,address,hash_token(token)))
    c.commit();cl=c.execute('SELECT * FROM clients WHERE phone=?',(phone,)).fetchone()
    return self.send_json({'token':token,'client':public_client(c,cl)})
   if path=='/api/orders':
    cl=self.client(c)
    if not cl:return self.send_json({'error':'Faça seu cadastro primeiro'},401)
    items=data.get('items',[])
    if not isinstance(items,list) or not items or len(items)>50:return self.send_json({'error':'Pedido inválido'},400)
    prices=[[17,24],[17,24],[16,23],[15,20],[15,20],[12,18],[12,16],[12,18]]
    clean=[];total=0;units=0
    for x in items:
     try:i=int(x['product']);size=int(x['size']);qty=int(x['qty']);obs=str(x.get('obs',''))[:250]
     except Exception:return self.send_json({'error':'Item inválido'},400)
     if size not in (0,1) or qty not in range(1,30) or x.get('type')!='Garrafa':return self.send_json({'error':'Opção indisponível'},400)
     row=c.execute('SELECT price350,price500 FROM products WHERE id=? AND active=1',(i,)).fetchone()
     if not row:return self.send_json({'error':'Produto indisponível'},400)
     price=row['price350'] if size==0 else row['price500']
     if price is None or price<=0:return self.send_json({'error':'Preço não cadastrado'},400)
     total+=price*qty
     units+=qty
     clean.append({'product':i,'size':size,'qty':qty,'obs':obs,'price':price,'type':'Garrafa'})
    if units>100:return self.send_json({'error':'Limite excedido'},400)
    cur=c.execute('INSERT INTO orders(client_id,items,total,units) VALUES(?,?,?,?)',(cl['id'],json.dumps(clean,ensure_ascii=False),total,units));c.commit()
    return self.send_json({'order_id':cur.lastrowid,'total':total,'status':'pending'})
   if path=='/api/admin/approve':
    if not self.admin():return self.send_json({'error':'PIN inválido'},403)
    oid=int(data.get('id',0));status=data.get('status')
    if status not in ('approved','rejected'):return self.send_json({'error':'Status inválido'},400)
    cur=c.execute('UPDATE orders SET status=? WHERE id=? AND status="pending"',(status,oid));c.commit()
    return self.send_json({'ok':bool(cur.rowcount)})
   if path=='/api/admin/order_status':
    if not self.admin():return self.send_json({'error':'PIN inválido'},403)
    oid=int(data.get('id',0));status=data.get('status')
    if status not in ('pending','approved','rejected'):return self.send_json({'error':'Status inválido'},400)
    cur=c.execute('UPDATE orders SET status=? WHERE id=?',(status,oid));c.commit()
    return self.send_json({'ok':bool(cur.rowcount)})
   if path=='/api/admin/redeem':
    if not self.admin():return self.send_json({'error':'PIN inválido'},403)
    phone=''.join(x for x in str(data.get('phone','')) if x.isdigit())
    cl=c.execute('SELECT * FROM clients WHERE phone=?',(phone,)).fetchone()
    if not cl:return self.send_json({'error':'Cliente não encontrado'},404)
    p=public_client(c,cl)
    if p['rewards']<1:return self.send_json({'error':'Cliente ainda não tem prêmio'},400)
    c.execute('INSERT INTO redemptions(client_id) VALUES(?)',(cl['id'],));c.commit()
    return self.send_json({'ok':True,'client':public_client(c,cl)})
  return self.send_json({'error':'Rota não encontrada'},404)
if __name__=='__main__':
 db().close()
 print(f'Mix0Grau disponível em http://localhost:{PORT}')
 print(f'Admin: http://localhost:{PORT}/admin.html')
 if not ADMIN_PIN:print('ATENÇÃO: defina MIX0GRAU_ADMIN_PIN para habilitar administração.')
 ThreadingHTTPServer(('0.0.0.0',PORT),Handler).serve_forever()
