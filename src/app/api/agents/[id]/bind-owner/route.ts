import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { prisma } from "@/lib/db";
import { authOptions } from "@/lib/auth";
import crypto from "crypto";
import { encryptPrivateKey, deriveUrnFromEd25519PubKey } from "@/lib/crypto";
import { registerConsole, ControlError } from "@/lib/control-transport";
import { requireSameOrigin } from "@/lib/control-protocol";

function publicIdentity(user: {virtualUrn:string|null;virtualEd25519PublicKey:string|null;virtualX25519PublicKey:string|null}) {
  return {virtualUrn:user.virtualUrn,virtualEd25519PublicKey:user.virtualEd25519PublicKey,virtualX25519PublicKey:user.virtualX25519PublicKey};
}
async function owner(id:string) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id) throw new ControlError("Unauthorized",401);
  if (!await prisma.agent.findFirst({where:{id,userId:session.user.id}})) throw new ControlError("Connection not found",404);
  const user = await prisma.user.findUnique({where:{id:session.user.id}});
  if(!user) throw new ControlError("User not found",404);
  return user;
}
const failed = (error:unknown) => NextResponse.json({error:error instanceof ControlError?error.message:"无法创建控制台身份。"},
  {status:error instanceof ControlError?error.status:500});
export async function GET(request:Request,{params}:{params:{id:string}}) {
  try {return NextResponse.json(publicIdentity(await owner(params.id)),{headers:{"Cache-Control":"no-store"}});} catch(error){return failed(error);}
}
export async function POST(request:Request,{params}:{params:{id:string}}) {
  try {
    let user = await owner(params.id);
    try {requireSameOrigin(request);} catch {throw new ControlError("Forbidden origin",403);}
    const masterKey = process.env.NEXTAUTH_SECRET;
    if (!masterKey) throw new ControlError("服务器必须配置 NEXTAUTH_SECRET。",503);
    if (!user.virtualUrn) {
      const ed = crypto.generateKeyPairSync("ed25519"), x = crypto.generateKeyPairSync("x25519");
      const edPublic = ed.publicKey.export({type:"spki",format:"der"}).subarray(-32).toString("hex");
      const xPublic = x.publicKey.export({type:"spki",format:"der"}).subarray(-32).toString("hex");
      const edSecret = encryptPrivateKey(ed.privateKey.export({type:"pkcs8",format:"der"}).toString("hex"),masterKey);
      const xSecret = encryptPrivateKey(x.privateKey.export({type:"pkcs8",format:"der"}).toString("hex"),masterKey);
      await prisma.user.updateMany({where:{id:user.id,virtualUrn:null},data:{
        virtualUrn:deriveUrnFromEd25519PubKey(edPublic),virtualEd25519PublicKey:edPublic,virtualX25519PublicKey:xPublic,
        virtualEd25519PrivateKey:JSON.stringify(edSecret),virtualX25519PrivateKey:JSON.stringify(xSecret),virtualKeySalt:edSecret.salt,
      }});
      user = (await prisma.user.findUnique({where:{id:user.id}}))!;
    }
    // Registration is retried for an existing identity too; a partial network failure never rotates its keys.
    await registerConsole(user);
    return NextResponse.json({...publicIdentity(user),registered:true,
      note:"控制台身份已注册。请在 agent 本机配对该 URN，并将其加入 allow_from；保存 Web 连接本身不授予访问权。"});
  } catch(error){return failed(error);}
}
