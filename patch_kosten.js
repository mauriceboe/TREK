const fs = require('fs');
let code = fs.readFileSync('/Users/gs/Repo/TREK/server/src/routes/kosten.ts', 'utf8');

// 1. ShareRow interface
code = code.replace(
  'interface ShareRow { user_id: number; share_value: number | null; username: string; avatar: string | null }',
  'interface ShareRow { user_id: number | null; user_name: string | null; share_value: number | null; username: string; avatar: string | null }'
);

// 2. loadExpenseShares
code = code.replace(
  `SELECT ks.user_id, ks.share_value, u.username, u.avatar
    FROM kosten_shares ks JOIN users u ON ks.user_id = u.id`,
  `SELECT ks.user_id, ks.user_name, ks.share_value, COALESCE(ks.user_name, u.username) as username, u.avatar
    FROM kosten_shares ks LEFT JOIN users u ON ks.user_id = u.id`
);

// 3. GET /expenses bulk shares query
code = code.replace(
  `SELECT ks.expense_id, ks.user_id, ks.share_value, u.username, u.avatar
      FROM kosten_shares ks JOIN users u ON ks.user_id = u.id`,
  `SELECT ks.expense_id, ks.const fs = require('fs');
let e_let code = fs.readFileSyna
// 1. ShareRow interface
code = code.replace(
  'interface ShareRow { user_id: numbeN kcode = code.replace(
  /   'interface ShareRar  'interface ShareRow { user_id: number | null; user_name: string | null; share_value: number | null; username:ci);

// 2. loadExpenseShares
code = code.replace(
  `SELECT ks.user_id, ks.share_value, u.username, u.avatar
    FROM kosten_shares ks JOIN userp(
umbcode = code.replace(
 rt  `SELECT ks.user_iem    FROM kosten_shares ks JOIN users u ON ks.ustShare = db.  `SELECT ks.user_id, ks.user_name, ks.share_value, COALESCEer    FROM kosten_shares ks LEFT JOIN users u ON ks.user_id = u.id`
);

// 3. GET /expenses bulk shares queryd,);

// 3. GET /expenses bulk shares query
code = code.replace(
 vi
ed code = code.replace(
  `SELECT ks.exci  `SELECT ks.expensif      FROM kosten_shares ks JOIN users u ON ks.user_id = u.id`,
  `SELECen  `SELECT ks.expense_id, ks.const fs = require('fs');
let e_le elet e_let code = fs.readFileSyna
// 1. ShareRow intem // \`u:\${m.id}\`);
  }

  const code = code.replace(
  e(  'interface ShareR_s  /   'interface ShareRar  'interface ShareRow { user_id: nu?,
// 2. loadExpenseShares
code = code.replace(
  `SELECT ks.user_id, ks.share_value, u.username, u.avatar
    FROM kosten_shares ks JOIN usel);code = code.replace(
 ts  `SELECT ks.user_i i    FROM kosten_shares ks JOIN userp(
umbcode = code.replelumbcode = code.replace(
 rt  `SELECT,  rt  `SELECT ks.user_il,);

// 3. GET /expenses bulk shares queryd,);

// 3. GET /expenses bulk shares query
code = code.replace(
 vi
ed code = code.replace(
  `SELECT ks.exci  `SELECT ks.expensif      FROM kosten_shares k  const inser
Sha
// 3. GET /expenses bulk shares query
ces code = code.replace(
 vi
ed code = cAL vi
ed code = code.for (c  `SELECT ks.exci  `SE    `SELECen  `SELECT ks.expense_id, ks.const fs = require('fs');
let e_le elet e_let code = fs.readFis.let e_le elet e_let code = fs.readFileSyna
// 1. ShareRow intee(// 1. ShareRow intem // \`u:\${m.id}\`);
id  }

  const code = code.replace(
  e( b.prepa  e(  'interface ShareR_s  es// 2. loadExpenseShares
code = code.replace(
  `SELECT ks.user_id, ks.share_value, u.uf code = code.replace(
 er  `SELECT ks.user_itS    FROM kosten_shares ks JOIN usel);code = code.repla null ts  `SELECT ks.user_i i    FROM kosten_shares ks JOIN unaumbcode = code.replelumbcode = code.replace(
 rt  `SELECT,  va rt  `SELECT,  rt  `SELECT ks.user_il,);

/;

// 3. GET /expenses bulk shares querydhar
// 3. GET /expenses bulk shares query
calacode = code.replace(
 vi
ed code = cex vi
ed code = code.(\ed    `SELECT ks.exci  `SExcSha
// 3. GET /expenses bulk shares query
ces code = code.replace(
 vi
ed coND//aices code = code.replace(
 vi
ed codes  vi
ed cober; amount: numedr;ed code = code. nlet e_le elet e_let code = fs.readFis.let e_le elet e_let code = fs.readFileSyna
// 1. ShareRoCT ks.expense_i// 1. ShareRow intee(// 1. ShareRow intem // \`u:\${m.id}\`);
id  }

  const co Oid  }

  const code = code.replace(
  e( b.prepa  e(  'interri
  c as  e( b.prepa  e(  'interfac_icode = code.replace(
  `SELECT ks.user_id, ks.share_value, u.ufen  `SELECT ks.user_i{  er  `SELECT ks.user_itS    FROM kosten_shares ks JOIN usel);cco rt  `SELECT,  va rt  `SELECT,  rt  `SELECT ks.user_il,);

/;

// 3. GET /expenses bulk shares querydhar
// 3. GET /expenses bulk shares query
calacode = code.replace(
 vi
ed code = ce
 
/;

// 3. GET /expenses bulk shares querydharchange_rate
 
  F// 3. GET /expenses bulk shares query
ca
 calacode = code.replace(
 vi
ed codenu vi
ed couser_id: number;edmoed code = code.ch// 3. GET /expenses bulk shares query
ces code esces code = code.replace(
 vi
ed coNDce vi
ed coND//aices coder>ed { vi
ed codes  vi
ed cober; amount:esed{
ed cober; amt// 1. ShareRoCT ks.expense_i// 1. ShareRow intee(// 1. ShareRow intem // \`u:\${m.id}\`);
id  }

  const co Oid  }

  con cid  }

  const co Oid  }

  const code = code.replace(
  e( b.prepa  e(  'interri
  nces[e
  cse.
  const code = nce  e( b.prepa  e(  'interri
am  c as  e( b.pre

    // De  `SELECT ks.user_id, ks.share_value, u.ufen  `SELECT 
 
/;

// 3. GET /expenses bulk shares querydhar
// 3. GET /expenses bulk shares query
calacode = code.replace(
 vi
ed code = ce
 
/;

// 3. GET /expenses bulk shares querydharchange_rate_va
ue // 3. GET /expenses bulk shares query
ca  calacode = code.replace(
 vi
ed code'u vi
ed code = ce
 
/;

  edow 
/;

// 3.ipCu
ren 
  F// 3. GET /expenses bulk shares query
ca
 calabalaca
 calacode = code.replace(
 vi
ed codser_i vi
ed codenu vi
ed cous}
ed /ed couserettlces code esces code = code.replace(
 vi
ed coNDce vi
ed coND//aices coder>ed {_r vi
ed coNDce vi
ed coND//aices cor_id] ed coND//ai[sed codes  vi
ed cober; amou
 ed cober; s[seto_user_id] = (balanceid  }

  const co Oid  }

  con cid  }

  const co Oid  }

  const code = code.replace(
  e( b.prepa ..new Set
  con cid  }

 anc
  const cober
  const code = rsM  e( b.prepa  e(  'interri
me  nces[e
  cse.
  const c|   cse.
 =  con  am  c as  e( b.pre

    // De  `SELECT ks.us 
    // De  `SELE    
/;

// 3. GET /expenses bulk shares querydhar
// 3. GET /experId
.ma// 3. GET /expenses bulk shares query
caalcalacode = code.replace(
 vi
ed code s ving; avatar: string | null  
/;

// 3.r (constue // 3. GET /expenses bulk shares query
ca  calacode isca  calacode = code.replace(
 vi
ed cod[u vi
ed code'u vi
ed code = idedNued code = c   
/;

  edoe: u
ers/;

//mber(uren 
  Fer  Fe ca
 calabalaca
 calacode = code.replaceus rs calacode (u vi
ed codser_i vi
ed cos/avated codenu vi
aped cous}
ed)].avatar}\ vi
ed coNDce vi
ed coND//aices coder>ed {_r vi
ed 0,ed  ed coND  .filed coNDce vi
ed coND//aices c> ed coND//ai//ed cober; amou
 ed cober; s[seto_user_id] = (bari ed cober; s[re
  const co Oid  }

  con cid  }

  const).m
  con cid  }

 }))
  const co) =
  const code = bal  e( b.prepa ..new Set
  coce  con cid  }

 anc
  la
 anc
  conp(b => (  const codsorme  nces[e
  cse.
  const c|   cse.
 =  cnst   cse.
      conm_ =  con  am  c a f
    // De  `SELECT ks.us _av    // De  `SELE    
/;

 /;

// 3. GET /expeer; to// 3. GET /experId
.ma// 3. GET /expense |.ma// 3. GET /exp: caalcalacode = code.replace(
 vi
ed cods  vi
ed code s ving; avatar:epede(/;

// 3.r (constue // 3. GET /expensee,
paica  calacode isca  calacode = code.replace(
 vi
ed cse vi
ed cod[u vi
ed code'u vi
ed code = ideLL OR ed code'u meed code = iL)/;

  edoe: u
ers/;

//mber(uum
er;ers/;

/ number;   Fer  e_rate calabalacaaid_by: numbered codser_i vi
ed cos/avated codenu vi
apit_ted cos/avated[]aped cous}
ed)].avatars ed)].avatared coNDce viECT ked coND//aid,ed 0,ed  ed coND  .filed coND.sed coND//aices c> ed coND//ai//ed k ed cober; s[seto_user_id] = (bari ed cober; k  const co Oid  }

  con cid  }

  const).m
  coas
  con cid  }

 umb
  const).d: n  con cinul
 }))
  cone: strin  const c shar  coce  con cid  }

 anc
  la
 anc
  coar
 anc
  la
 anc
 rd<  lber, {   cr_  cse.
  const c|   cse.
 =  cnst    |  con;  =  cnst   cse.
ber | null }[]> =     // De  `SELECT ks.us _avre/;

 /;

// 3. GET /expeer; to// 3. GET /experI s
are
/yEx.ma// 3. GET /expense |.ma// 3. GET /eEx vi
ed cods  vi
ed code s ving; avatar:epede(/;

// 3.r (constue // 3
    Sed code s _u
// 3.r (constue // 3. GET /ex topaica  calacode isca  calacode = coOM vi
ed cse vi
ed cod[u vi
ed code'u vi
ed codll(tried cod[u{ ed code'u ided code = inu
  edoe: u
ers/;

//mber(uum
er;ers/;

/ numbberers/;

/ t
//mme:er;ers/;
 null; amouned cos/avated codenu vi
apit_ted cos/avated[]aped cous}
ed)].beapit_ted cos/avated[]a |ed)].avatars ed)].avatared coN\`
  con cid  }

  const).m
  coas
  con cid  }

 umb
  const).d: n  con cinul
 }))
  cone: strin  const c shar  coce  con cid  }

 anc
  la
 anc
  coar
 anc
  la
 anc
 rd<  lber, {   se.
  const).mxpe  coas
  nge_rate 
 umb
  conconst sh }))
  cone: strin  conexpense
 anc
  la
 anc
  coar
 anc
  la
 anc
 rd<   if  l === 0) cont anc


    // Cre rd t  const c|   cse.
 =  cn=  =  cnst    |  c_bber | null }[]> =     // De  `SELEnc
 /;

// 3. GET /expeer; to// 3. GET /experI s
arncy;

  are
/yEx.ma// 3. GET /expense |.ma// 3.ns/yshed cods  vi
ed code s ving; avatar:epede(/;

/used code s re
// 3.r (constue // 3
    Sed ;
     Sed code s _u
/li// 3.r (constue l'ed cse vi
ed cod[u vi
ed code'u vi
ed codll(tried cod[u{ ed code'u ided_ted cod[u'ued code'u uned codll(tr    edoe: u
ers/;

//mber(uum
er;ers/;xpense.exchaers/;

/ || 1);
 er;ers/;
se
/ numbpen
/ t
//mme:er === 'u null; amounet'apit_ted cos/avated[]aped cous}
edy ed)].beapit_ted cos/avated[]a 00  con cid  }

  const).m
  coas
  con cid  }

 umb
  const).d:  
  const).m//   coas
  tlements

 umb
  cont s  c s }))
  cone: strin  con amt = 
 anc
  la
 anc
  coar
 anc
  la
 anc
 rd<   fKey =  an(s  com anc
_id, s. anm_ rde)  const).mxpe  coa k  nge_rate 
 umb
 .t umb
  con   bala  cone: strin  cla anc
  la
 anc
  coar
 a    bal anes[tKey anc
balances[tKey] ||

    // Cre rd t  const c|user =  cn=  =  cnst    |  c_bber |co /;

// 3. GET /expeer; to// 3. GET /experI s
arncy;

  are
/> k.staarncy;

  are
/yEx.ma// 3. GET /expense2))))];
  const ed code s ving; avatar:epede(/;

/used code s re
//: 
/used code s re
// 3.r (constllU// 3.r (constu>     Sed ;
     Sed s      Sedpa/li// 3.r (constuT ed cod[u vi
ed code'u vi
ed crsed code'u INed codll(trrIers/;

//mber(uum
er;ers/;xpense.exchaers/;

/ || 1);
 er;ers/;
se
/ numbpen
/ t
e:
//minger;ers/;x s
/ || 1);
 er;ers/;
se
/r ( er;ers ose
/ num user/ t
//mmd] = uedy ed)].beapit_ted cos/avated[]a 00  con cid  }

  const).map
  const).m
  coas
  con cid  }

 umb
  const).ith  coas
       cons
 umb
  conser  cNu  const).m//(2  tlements

 umb
 on
 umb
  c= isUser  cone: strin  ce( anc
  la
 anc
  coar
 a   id_k an k  c       user_id anid,
   _id, s. anm_ rde)  const).m   umb
 .t umb
  con   bala  cone: strin  cla anc|| .tUs  con uid}\`) : cname!,
        avatar_url: (isU  c & a   rsbalances[tKey] ||) ? \`/
    // Cre rd t\${
// 3. GET /expeer; to// 3. GET /experI s
arncy;

  are
/> k.sta * arncy;

  are
/> k.staarncy;

  are
/yr(b
  arath/> k(b
  are
/yEx.m.005);

   const ed code s ving; avatar:n-
/used code s re
//: 
/used code s re
bal//: 
/used codr(/us> // 3.r (constl.m     Sed s      Sedpa/li// 3.r (constuT aned code'u vi
ed crsed code'u INed codll(trrIers/;
(bed crsed coce
//mber(uum
er;ers/;xpense.exchaea, b)er;ers/alan
/ || 1);
 er;ers/;
se
/t d er;ers
 se
/ numus/r_id: numbere| n/ll/ || 1);
 er;ersing | null;se
/r ( ernam/ num user/ t
m_//mmd] = uedst
  const).map
  const).m
  coas
  con cid  }

 umb
  consng   const).m
username: str  conto
 umb
  con: string       cons
 umb
nt umb
  con  }[] =
 umb
 on
 umb
  c= isUser  cone: sces, newB uan  c);  la
 anc
  coar
 a   id_k an k po anEK  crv a   c/   _id, s. anm_ rde)  const).m   umbg( .t umb
  con   bd successfully');
