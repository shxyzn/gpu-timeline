"""Original 50-second v2.1 product film. Illustrative UI, not live server results.

No persistent corner labels, captions, timecode or footer. All visual and audio
assets are generated here; Apple footage, music, logos and fonts are not used.
"""
import argparse
from functools import lru_cache
import json
import math
from pathlib import Path
import subprocess
import wave

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

W,H,FPS,DURATION=1920,1080,30,50
NAME='CVML-GPU-Timeline-v2.1-film'
BLUE='#087cff';INK='#202126';GRAY='#82858e';WHITE='#f5f5f7'
REGULAR=BOLD=None
CUTS=[0,3.125,6.25,13.75,20,26.25,32.5,38.75,43.75,50]

def clamp(x):return max(0,min(1,x))
def smooth(x):x=clamp(x);return x*x*(3-2*x)
def ease(x):return 1-(1-clamp(x))**4
@lru_cache(None)
def font(size,weight=500):
    f=ImageFont.truetype(BOLD if weight>=650 else REGULAR,int(size))
    try:
        axes=f.get_variation_axes();f.set_variation_by_axes([weight if a['name']==b'Weight' else a['default'] for a in axes])
    except (OSError,AttributeError):pass
    return f

def txt(draw,x,y,s,size=28,fill=INK,weight=500,anchor='lt'):
    draw.text((round(x),round(y)),str(s),font=font(size,weight),fill=fill,anchor=anchor,stroke_width=0)
def rr(draw,rect,fill,r=24,outline=None,width=1):
    draw.rounded_rectangle(tuple(round(v) for v in rect),round(r),fill=fill,outline=outline,width=width)
def check(draw,x,y,size=26,selected=True):
    rr(draw,(x,y,x+size,y+size),BLUE if selected else '#fff',6,None if selected else '#d5d8df',2)
    if selected:draw.line([(x+size*.23,y+size*.52),(x+size*.43,y+size*.72),(x+size*.79,y+size*.30)],fill='white',width=max(2,round(size*.12)),joint='curve')
def badge(draw,x,y,value,fg=BLUE,bg='#eaf3ff'):
    width=font(20,550).getlength(value)+30;rr(draw,(x,y,x+width,y+40),bg,20);txt(draw,x+15,y+7,value,20,fg,550);return width

@lru_cache(None)
def background(light=False):
    yy,xx=np.mgrid[0:270,0:480];x=xx/480;y=yy/270
    if light:
        glow=np.exp(-((x-.68)**2/.23+(y-.6)**2/.42));base=np.stack([246+glow*6,247+glow*6,249+glow*5],axis=-1)
    else:
        glow=np.exp(-((x-.58)**2/.17+(y-.63)**2/.19));rim=np.exp(-((x-.5)**2/.5+(y-1.15)**2/.06))
        base=np.stack([4+glow*9+rim*4,5+glow*12+rim*7,8+glow*22+rim*14],axis=-1)
    return Image.fromarray(np.clip(base,0,255).astype('uint8'),'RGB').resize((W,H),Image.Resampling.BICUBIC)

def fade_layer(base,layer,alpha=1):
    if alpha<1:layer=layer.copy();layer.putalpha(layer.getchannel('A').point(lambda a:round(a*clamp(alpha))))
    base.paste(layer,(0,0),layer)

@lru_cache(None)
def headline_asset(value,size=90,color=WHITE,weight=650):
    rows=value.split('\n');f=font(size,weight);width=math.ceil(max(f.getlength(row) for row in rows))+40;line=round(size*1.35)
    im=Image.new('RGBA',(width,line*len(rows)+28));d=ImageDraw.Draw(im)
    for i,row in enumerate(rows):txt(d,width/2,14+i*line,row,size,color,weight,'mt')
    return im

def headline(im,value,center=(960,510),size=90,color=WHITE,alpha=1,scale=1):
    asset=headline_asset(value,size,color)
    if scale!=1:asset=asset.resize((round(asset.width*scale),round(asset.height*scale)),Image.Resampling.BICUBIC)
    if alpha<1:asset=asset.copy();asset.putalpha(asset.getchannel('A').point(lambda a:round(a*clamp(alpha))))
    im.paste(asset,(round(center[0]-asset.width/2),round(center[1]-asset.height/2)),asset)

@lru_cache(None)
def version_asset():
    mask=Image.new('L',(1100,520));d=ImageDraw.Draw(mask);txt(d,550,250,'2.1',422,'white',650,'mm')
    yy,xx=np.mgrid[0:520,0:1100];v=(yy/520*.9+xx/1100*.35);shine=.78+.22*np.cos(v*math.pi*2)
    pixels=np.stack([185+shine*62,194+shine*52,209+shine*41],axis=-1)
    im=Image.fromarray(np.clip(pixels,0,255).astype('uint8'),'RGB').convert('RGBA');im.putalpha(mask);return im

def texture(w,h):
    im=Image.new('RGBA',(w,h));d=ImageDraw.Draw(im);rr(d,(1,1,w-2,h-2),'#ffffff',34,'#e5e7ed',2);return im,d

@lru_cache(None)
def server_card(index):
    im,d=texture(510,500);name=['Kimi','Leclerc','Sainz'][index];gpu=['RTX PRO 5000','RTX 4090 × 2','RTX 4090 × 2'][index]
    txt(d,38,40,name,40,INK,650);txt(d,39,100,gpu,21,GRAY)
    for i,(label,value) in enumerate([('GPU 인식','1 / 1' if index==0 else '2 / 2'),('GPU 온도',str(62+index*3)+'°C'),('점검 일정','2개')]):
        y=161+i*62;txt(d,39,y,label,23,GRAY);txt(d,471,y,value,25,INK,550,'rt')
    d.line((39,365,471,365),fill='#e8e9ee',width=2)
    rr(d,(35,399,475,462),'#087cff',16);txt(d,255,430,'모니터링 설정',24,'white',550,'mm');return im

@lru_cache(None)
def interval_card():
    im,d=texture(560,650);txt(d,40,38,'일반 점검',28,INK,650);badge(d,385,37,'반복')
    c=(280,280);r=145
    for n in range(60):
        a=n/60*math.tau-math.pi/2;inner=r-(19 if n%5==0 else 8)
        d.line((c[0]+math.cos(a)*inner,c[1]+math.sin(a)*inner,c[0]+math.cos(a)*r,c[1]+math.sin(a)*r),fill='#d0d6df',width=3 if n%5==0 else 2)
    txt(d,280,261,'30',108,INK,550,'mm');txt(d,280,349,'분마다',24,GRAY,500,'mm')
    rr(d,(35,465,525,530),'#f3f6fc',14);txt(d,58,486,'운영 시간',21,GRAY);txt(d,501,486,'09:00 – 18:00',24,INK,550,'rt')
    for i,day in enumerate('월화수목금토일'):
        x=36+i*71;rr(d,(x,555,x+62,610),'#eaf3ff' if i<5 else '#f4f4f6',13);txt(d,x+31,583,day,20,BLUE if i<5 else GRAY,550,'mm')
    return im

CHECKS=['GPU 응답','GPU 인식 개수','GPU 온도','NVIDIA 드라이버','GPU 오류 로그','CPU 부하','CPU 대기','메모리 여유','가동 시간','수집기 업로드','디스크 여유','저장장치 대기']
@lru_cache(None)
def check_sheet(count):
    im,d=texture(1140,580);txt(d,42,33,'점검 항목',29,INK,650);txt(d,1098,40,f'{count}개 선택',21,BLUE,550,'rt')
    for i,label in enumerate(CHECKS):
        x=35+i%3*360;y=106+i//3*108;selected=i<count
        rr(d,(x,y,x+348,y+91),'#f1f7ff' if selected else '#fafbfc',16,'#bcd8fc' if selected else '#eaecf1',2)
        check(d,x+22,y+30,28,selected);txt(d,x+66,y+30,label,24,INK,550)
    return im

@lru_cache(None)
def clock_card(hour):
    im,d=texture(490,405);cx,cy,r=245,169,111
    for n in range(60):
        a=n/60*math.tau-math.pi/2;inner=r-(14 if n%5==0 else 6)
        d.line((cx+math.cos(a)*inner,cy+math.sin(a)*inner,cx+math.cos(a)*r,cy+math.sin(a)*r),fill='#bfc7d2' if n%5==0 else '#e2e6ed',width=3 if n%5==0 else 2)
    a=(hour%12)/12*math.tau-math.pi/2;d.line((cx,cy,cx+math.cos(a)*69,cy+math.sin(a)*69),fill=INK,width=7);d.line((cx,cy,cx,cy-90),fill=BLUE,width=5);d.ellipse((cx-7,cy-7,cx+7,cy+7),fill=BLUE)
    txt(d,245,325,f'{hour:02d}:00',57,INK,550,'mm');return im

@lru_cache(None)
def apply_card(done):
    im,d=texture(590,475);badge(d,36,35,'서버 적용 완료' if done else '서버 적용 대기','#247648' if done else '#986724','#eaf7ee' if done else '#fff4df')
    txt(d,37,113,'서버 모니터링',36,INK,650);txt(d,38,175,'일반 점검 · 30분마다',25,GRAY);txt(d,38,222,'정밀 점검 · 09:00 / 21:00',25,GRAY)
    d.line((36,286,554,286),fill='#e7e9ef',width=2)
    if done:
        for i,label in enumerate(['GPU 응답','GPU 인식 개수','GPU 온도']):
            y=313+i*44;txt(d,38,y,label,22,GRAY);txt(d,550,y,'확인 완료',22,'#247648',550,'rt')
    else:
        txt(d,295,356,'수집기 연결을 기다립니다.',25,GRAY,500,'mm')
    return im

@lru_cache(None)
def result_card(index):
    im,d=texture(580,400)
    if index==0:
        txt(d,34,28,'실험 결과',27,INK,650)
        for i in range(4):d.line((35,115+i*65,545,115+i*65),fill='#edf0f5',width=2)
        pts=[(35+i*510/11,310-v*180) for i,v in enumerate([.06,.11,.10,.24,.39,.33,.53,.59,.63,.81,.79,.97])]
        d.line(pts,fill=BLUE,width=6,joint='curve');txt(d,35,350,'AIME · validation',20,GRAY)
    elif index==1:
        txt(d,34,28,'결과 이미지',27,INK,650)
        for row in range(2):
            for col in range(3):
                x=35+col*172;y=96+row*130;rr(d,(x,y,x+157,y+113),['#e5ecf8','#ebeff4','#e2e7f1'][(row+col)%3],12)
                d.ellipse((x+32,y+21,x+117,y+98),fill=['#a8b7d4','#b0a3c5','#91b4c6'][(row+col)%3]);d.polygon([(x+32,y+80),(x+80,y+13),(x+126,y+81)],fill='#d6e0f1')
    else:
        txt(d,34,28,'실험 노트',27,INK,650);txt(d,35,103,'각 서버의 결과를,',33,INK,550);txt(d,35,153,'하나의 보드에서.',33,INK,550)
        for i,w in enumerate([470,420,458,350]):rr(d,(35,242+i*27,35+w,253+i*27),'#e8ebf1',4)
    return im

@lru_cache(None)
def shadow_asset():
    im=Image.new('RGBA',(600,200));d=ImageDraw.Draw(im);d.ellipse((45,65,555,135),fill=(0,0,0,110));return im.filter(ImageFilter.GaussianBlur(28))

def project(im,asset,cx,cy,scale=1,yaw=0,pitch=0,alpha=1,shadow=False):
    # A textured plane in perspective, with a continuous camera glide.
    aw,ah=asset.size;corners=[]
    for x,y in [(-aw/2,-ah/2),(aw/2,-ah/2),(aw/2,ah/2),(-aw/2,ah/2)]:
        x*=scale;y*=scale;xx=x*math.cos(yaw);z=-x*math.sin(yaw);yy=y*math.cos(pitch)-z*math.sin(pitch);z=y*math.sin(pitch)+z*math.cos(pitch);persp=2600/(2600+z)
        corners.append((cx+xx*persp,cy+yy*persp))
    left=max(-800,math.floor(min(x for x,y in corners)));top=max(-800,math.floor(min(y for x,y in corners)))
    right=min(W+800,math.ceil(max(x for x,y in corners)));bottom=min(H+800,math.ceil(max(y for x,y in corners)))
    if right<=left or bottom<=top:return
    if shadow:
        sh=shadow_asset().resize((max(1,round(aw*scale*1.15)),max(1,round(ah*scale*.18))),Image.Resampling.BILINEAR)
        im.paste(sh,(round(cx-sh.width/2),round(cy+ah*scale*.50)),sh)
    dst=[(x-left,y-top) for x,y in corners];src=[(0,0),(aw,0),(aw,ah),(0,ah)];A=[];b=[]
    for (x,y),(u,v) in zip(dst,src):
        A.extend([[x,y,1,0,0,0,-u*x,-u*y],[0,0,0,x,y,1,-v*x,-v*y]]);b.extend([u,v])
    coeff=np.linalg.solve(np.array(A),np.array(b))
    warped=asset.transform((right-left,bottom-top),Image.Transform.PERSPECTIVE,coeff,Image.Resampling.BICUBIC)
    if alpha<1:warped.putalpha(warped.getchannel('A').point(lambda a:round(a*clamp(alpha))))
    im.paste(warped,(left,top),warped)

def scene(index,u):
    duration=CUTS[index+1]-CUTS[index];entry=ease(u/.85);exit=smooth((u-duration+.65)/.65)
    im=background(index==4).copy();d=ImageDraw.Draw(im)
    if index==0:
        asset=version_asset();scale=.94+.08*ease(u/3.125);project(im,asset,960,535,scale,yaw=.08*(1-entry),alpha=entry)
    elif index==1:
        headline(im,'서버의 상태를.\n먼저 알아보다.',center=(960,510+25*(1-entry)),size=104,alpha=entry,scale=.98+.02*entry)
    elif index==2:
        # Wide reveal becomes a macro shot of the actual settings control.
        zoom=1.0+1.3*smooth((u-2.2)/5.0);camera_x=24*math.sin(u*.55);focus=smooth((u-4.0)/3.4)
        if u<2.5:headline(im,'모든 서버를, 한곳에서.',center=(960,184),size=72,alpha=entry*(1-smooth((u-1.4)/1.1)))
        for i in [0,2,1]:
            x=960+(i-1)*555*zoom+camera_x;cy=580-180*zoom*focus+(1-ease((u-i*.1)/.9))*370
            project(im,server_card(i),x,cy,zoom,yaw=(i-1)*-.18+math.sin(u*.4)*.075,pitch=.045,alpha=ease((u-i*.1)/.65),shadow=True)
    elif index==3:
        # The camera pulls back from the interval dial to the operating window.
        reveal=smooth((u-.7)/1.8);scale=2.3-1.16*smooth((u-.7)/4.9)
        if u<1.6:headline(im,'원하는 때에.',center=(960,480),size=118,alpha=entry*(1-smooth((u-.6)/.7)))
        card=interval_card().copy();cd=ImageDraw.Draw(card);p=(u/duration)%1
        cd.arc((117,117,443,443),start=-90,end=-90+p*340,fill=BLUE,width=7)
        project(im,card,960+100*math.sin(u*.5),575-80*(1-reveal),scale,yaw=-.24+u*.058,pitch=.065,alpha=reveal,shadow=True)
    elif index==4:
        # A close-up selection rolls out into all twelve available checks.
        reveal=smooth((u-.65)/.8);zoom=2.3-1.1*smooth((u-.9)/4.1)
        if u<1.8:headline(im,'필요한 것만.',center=(960,430),size=114,color=INK,alpha=entry*(1-smooth((u-.8)/.7)))
        count=min(12,max(0,math.floor((u-.85)*3.1)));offset=(1-smooth((u-1)/4))*190
        project(im,check_sheet(count),960+offset,565+offset*.34,zoom,yaw=.12*(1-smooth(u/duration)),pitch=-.035,alpha=reveal,shadow=True)
    elif index==5:
        reveal=smooth((u-.7)/1.2)
        if u<1.6:headline(im,'하루 한 번. 혹은, 두 번.',center=(960,470),size=100,alpha=entry*(1-smooth((u-.6)/.8)))
        for i,hour in enumerate([9,21]):
            show=ease((u-.8-i*.7)/.9);x=960+(i-.5)*690*reveal+math.sin(u*.48+i)*28;y=545+math.sin(u*.45+i)*25
            project(im,clock_card(hour),x,y+(1-show)*360,1.35-.08*smooth(u/duration),yaw=(-.16 if i==0 else .16)+math.sin(u*.55)*.09,pitch=.04,alpha=show,shadow=True)
    elif index==6:
        reveal=smooth((u-.65)/1.15)
        if u<1.6:headline(im,'설정하고. 확인하고.',center=(960,470),size=110,alpha=entry*(1-smooth((u-.6)/.8)))
        done=u>=2.8;scale=1.38+.4*smooth((u-2.2)/3.7)
        project(im,apply_card(done),960+math.sin(u*.5)*50,545,scale,yaw=-.18+u*.045,pitch=.035,alpha=reveal,shadow=True)
        if u>3.0:headline(im,'수집기 연결 후, 자동으로.',center=(960,155),size=35,color='#aab5c9',alpha=smooth((u-3)/.7))
    elif index==7:
        headline(im,'CVML GPU Timeline',center=(960,394),size=78,alpha=entry)
        project(im,version_asset(),960,660,.57,alpha=entry)
    else:
        title_alpha=entry*(1-smooth((u-2.5)/1.3));reveal=smooth((u-1.0)/1.15)
        headline(im,'다음은, 결과.',center=(960,300-115*reveal),size=105,alpha=title_alpha)
        headline(im,'v2.2 커스텀 결과 보드 · 업데이트 예정',center=(960,435-110*reveal),size=32,color='#aab5c9',alpha=entry)
        zoom=.88+.25*smooth((u-1.5)/4.5)
        for i in [0,2,1]:
            show=ease((u-1.15-i*.12)/1.0);project(im,result_card(i),960+(i-1)*620*zoom+40*math.sin(u*.3),710+(1-show)*380,zoom,yaw=(i-1)*-.16+math.sin(u*.3)*.055,pitch=.04,alpha=show,shadow=True)
        if u>duration-.6:im=Image.blend(im,Image.new('RGB',(W,H),'#040508'),smooth((u-duration+.6)/.6))
    return im

def frame(t):
    index=next((i for i in range(len(CUTS)-1) if CUTS[i]<=t<CUTS[i+1]),len(CUTS)-2);u=t-CUTS[index]
    im=scene(index,u)
    if index and u<.36:im=Image.blend(scene(index-1,CUTS[index]-CUTS[index-1]),im,smooth(u/.36))
    return im

def soundtrack(path):
    rate=44100;n=rate*DURATION;mix=np.zeros((n,2),dtype=np.float64);rng=np.random.default_rng(21)
    def add(at,sound,pan=0):
        start=round(at*rate);size=min(len(sound),n-start)
        if start<0 or size<=0:return
        mix[start:start+size,0]+=sound[:size]*math.sqrt((1-pan)/2);mix[start:start+size,1]+=sound[:size]*math.sqrt((1+pan)/2)
    beat=60/96
    # Restrained original pulse, soft harmonic bed and glasslike arpeggios.
    for b in range(80):
        tt=np.arange(round(rate*.32))/rate
        if b%2==0:
            kick=np.sin(2*math.pi*(48*tt+21*(1-np.exp(-tt*22))/22))*np.exp(-tt*16)*.24;add(b*beat,kick)
        ht=np.arange(round(rate*.06))/rate;noise=rng.normal(0,1,len(ht));noise-=np.convolve(noise,np.ones(9)/9,mode='same');add(b*beat+beat/2,noise*np.exp(-ht*80)*.015,(-1 if b%2 else 1)*.5)
        if b%2==0:
            note=[69,76,81,73,76,80,71,76][(b//2)%8];tt=np.arange(round(rate*1.35))/rate;freq=440*2**((note-69)/12)
            tone=(np.sin(2*math.pi*freq*tt)+.24*np.sin(2*math.pi*freq*2*tt))*np.exp(-tt*3.7)*(1-np.exp(-tt*100))*.075
            add(b*beat,tone,math.sin(b*.8)*.65);add(b*beat+.31,tone*.22,-math.sin(b*.8)*.65)
    for section,notes in enumerate([[45,52,60,64],[41,48,57,60],[48,55,59,64],[43,50,57,62]]):
        at=section*12.5;tt=np.arange(round(rate*12.5))/rate;env=np.sin(math.pi*np.minimum(tt/12.5,1))**.7
        pad=sum(np.sin(2*math.pi*(440*2**((note-69)/12))*tt)*.017 for note in notes)*env
        add(at,pad,-.2);add(at+.02,pad*.85,.2)
    for at in CUTS[2:-1]:
        tt=np.arange(round(rate*.7))/rate;noise=rng.normal(0,1,len(tt));noise=np.convolve(noise,np.ones(50)/50,mode='same');add(at-.45,noise*np.sin(math.pi*tt/.7)**2*.13)
    envelope=np.minimum(1,np.arange(n)/rate/1.2)*np.minimum(1,(n-np.arange(n))/rate/1.6);mix*=envelope[:,None]
    mix=np.tanh(mix*2);peak=np.max(np.abs(mix));mix*=.77/max(peak,.001)
    with wave.open(str(path),'wb') as f:f.setnchannels(2);f.setsampwidth(2);f.setframerate(rate);f.writeframes((mix*32767).astype('<i2').tobytes())

def verify(directory):
    movie=directory/(NAME+'.mp4');p=json.loads(subprocess.check_output(['ffprobe','-v','error','-show_streams','-show_format','-of','json',str(movie)]))
    video=next(s for s in p['streams'] if s['codec_type']=='video');audio=[s for s in p['streams'] if s['codec_type']=='audio']
    assert video['codec_name']=='h264' and (video['width'],video['height'])==(W,H)
    assert abs(float(p['format']['duration'])-DURATION)<.1 and video['r_frame_rate']=='30/1'
    assert len(audio)==1 and audio[0]['codec_name']=='aac'
    with Image.open(directory/'poster-v2.1.jpg') as poster:assert poster.size==(W,H)
    subprocess.run(['ffmpeg','-v','error','-i',str(movie),'-f','null','-'],check=True)
    print('v2.1 verified: 1920×1080, 30 fps, 50 seconds, original AAC stereo; full decode passed.',flush=True)

def main():
    global REGULAR,BOLD
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--regular');p.add_argument('--bold');p.add_argument('--output',default='dist/media');p.add_argument('--preview',action='store_true');p.add_argument('--verify',action='store_true')
    args=p.parse_args();out=Path(args.output);out.mkdir(parents=True,exist_ok=True)
    if args.verify:verify(out);return
    if not args.regular or not args.bold:p.error('--regular and --bold are required for rendering')
    REGULAR=args.regular;BOLD=args.bold
    if args.preview:
        samples=[1.8,4.7,10,17.2,23.8,29.5,36.1,41.2,47.6]
        thumbw=640;thumbh=360;board=Image.new('RGB',(thumbw*3,thumbh*3),'black')
        for i,t in enumerate(samples):
            im=frame(t);im.save(out/f'v21-frame-{t:g}.jpg',quality=94);board.paste(im.resize((thumbw,thumbh),Image.Resampling.LANCZOS),(i%3*thumbw,i//3*thumbh))
        board.save(out/'v21-storyboard.jpg',quality=95);print(str(out/'v21-storyboard.jpg'),flush=True);return
    audio=out/'v21-original-score.wav';soundtrack(audio)
    temp=out/'v21-silent.mp4'
    command=['ffmpeg','-hide_banner','-loglevel','error','-y','-f','rawvideo','-pix_fmt','rgb24','-s',f'{W}x{H}','-r',str(FPS),'-i','-','-an','-c:v','libx264','-preset','fast','-crf','19','-pix_fmt','yuv420p','-threads','4',str(temp)]
    proc=subprocess.Popen(command,stdin=subprocess.PIPE)
    try:
        for f in range(DURATION*FPS):
            proc.stdin.write(frame(f/FPS).tobytes())
            if f%150==0:print(f'v2.1 film {f//FPS:02d}/{DURATION}s',flush=True)
        proc.stdin.close()
        if proc.wait():raise RuntimeError('Film encoding failed')
    except BaseException:
        proc.kill();proc.wait();raise
    subprocess.run(['ffmpeg','-hide_banner','-loglevel','error','-y','-i',str(temp),'-i',str(audio),'-map','0:v:0','-map','1:a:0','-c:v','copy','-af','loudnorm=I=-18:TP=-1.5:LRA=8','-c:a','aac','-b:a','192k','-t',str(DURATION),'-movflags','+faststart',str(out/(NAME+'.mp4'))],check=True)
    frame(1.8).save(out/'poster-v2.1.jpg',quality=95);temp.unlink();audio.unlink();verify(out)

if __name__=='__main__':main()
