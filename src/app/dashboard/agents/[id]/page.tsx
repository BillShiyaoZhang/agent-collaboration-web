import {getServerSession} from "next-auth";
import {notFound} from "next/navigation";
import {authOptions} from "@/lib/auth";
import {prisma} from "@/lib/db";
import {RemoteWorkbench} from "@/components/remote-workbench";
export default async function AgentPage({params}:{params:{id:string}}){
 const session=await getServerSession(authOptions);
 const agent=session?.user?.id?await prisma.agent.findFirst({where:{id:params.id,userId:session.user.id},select:{id:true,name:true,urn:true}}):null;
 if(!agent)notFound();
 return <div className="mx-auto max-w-5xl"><RemoteWorkbench agent={agent}/></div>;
}
